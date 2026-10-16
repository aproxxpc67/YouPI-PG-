import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  Database,
  runMigrations,
  PaymentSessionRepository,
  ObservationRepository,
  ReceivingAccountRepository,
  SupportTicketRepository,
  AuditLogRepository
} from '@youpi/db';
import { QueueEngine, ObservationNormalizer, AttributionEngine } from '../index.js';
import { PaymentStatus, ObserverSource } from '@youpi/common';

describe('Unique payable amounts allow concurrent sessions per receiving account', () => {
  const accountId = '00000000-0000-0000-0000-000000000002';
  let db;
  let merchant;
  let sessionRepo;
  let queueEngine;
  let attributionEngine;

  function setup(maxAmountOffsetPaise) {
    db = new Database({ inMemory: true });
    merchant = runMigrations(db).defaultMerchant;
    sessionRepo = new PaymentSessionRepository(db, { maxAmountOffsetPaise });
    queueEngine = new QueueEngine({ sessionRepo, accountRepo: new ReceivingAccountRepository(db) });
    attributionEngine = new AttributionEngine({
      sessionRepo,
      obsRepo: new ObservationRepository(db),
      ticketRepo: new SupportTicketRepository(db),
      auditRepo: new AuditLogRepository(db),
      gracePeriodMs: 0
    });
  }

  let orderSeq = 0;
  function startSession(amountPaise) {
    const session = sessionRepo.create({
      merchantId: merchant.id,
      receivingAccountId: accountId,
      orderId: `ORD-${++orderSeq}`,
      amountPaise
    });
    const result = queueEngine.enqueueOrActivate(session.id, accountId, 300000);
    return { session: sessionRepo.findById(session.id), result };
  }

  function observe(amountPaise, utr) {
    return attributionEngine.processObservation(ObservationNormalizer.normalize({
      source: ObserverSource.GOOGLE_MESSAGES,
      receivingAccountId: accountId,
      amountPaise,
      bankReferenceNumber: utr,
      rawPayload: { text: `Received Rs ${Number(amountPaise) / 100}` }
    }));
  }

  afterEach(() => db.close());

  describe('with offsets enabled (99 paise)', () => {
    beforeEach(() => setup(99));

    test('same-amount sessions are all ACTIVE with distinct payable amounts', () => {
      const a = startSession(49900n);
      const b = startSession(49900n);
      const c = startSession(49900n);

      for (const { session } of [a, b, c]) {
        assert.equal(session.status, PaymentStatus.ACTIVE);
        assert.equal(session.amountPaise, 49900n, 'order amount is never changed');
      }
      assert.deepEqual(
        [a, b, c].map(x => x.session.payableAmountPaise),
        [49900n, 49901n, 49902n]
      );
    });

    test('different order amounts each start at offset 0', () => {
      const a = startSession(49900n);
      const b = startSession(20000n);
      assert.equal(a.session.payableAmountPaise, 49900n);
      assert.equal(b.session.payableAmountPaise, 20000n);
    });

    test('each bank credit is attributed to the session with that exact payable amount', () => {
      const a = startSession(49900n);
      const b = startSession(49900n);
      const c = startSession(49900n);

      // Credits arrive out of order
      const resB = observe(49901n, 'UTR-B');
      const resC = observe(49902n, 'UTR-C');
      const resA = observe(49900n, 'UTR-A');

      assert.equal(resB.paymentSessionId, b.session.id);
      assert.equal(resC.paymentSessionId, c.session.id);
      assert.equal(resA.paymentSessionId, a.session.id);
      for (const { session } of [a, b, c]) {
        assert.equal(sessionRepo.findById(session.id).status, PaymentStatus.SUCCESS);
      }
    });

    test('a credit matching no payable amount is not attributed', () => {
      const a = startSession(49900n);
      startSession(49900n);
      const res = observe(49905n, 'UTR-X');
      assert.equal(res.attributed, false);
      assert.equal(sessionRepo.findById(a.session.id).status, PaymentStatus.ACTIVE);
    });

    test('an expired session keeps its amount reserved so a late credit cannot hit a new session', () => {
      const a = startSession(49900n);
      sessionRepo.transitionToTerminal(a.session.id, PaymentStatus.EXPIRED);

      const b = startSession(49900n);
      assert.equal(b.session.payableAmountPaise, 49901n);

      const late = observe(49900n, 'UTR-LATE');
      assert.equal(late.attributed, false);
      assert.equal(late.lateMatch, true);
      assert.equal(late.paymentSessionId, a.session.id);
      assert.equal(sessionRepo.findById(b.session.id).status, PaymentStatus.ACTIVE);
    });

    test('the account slot flag stays busy until the last live session ends', () => {
      const a = startSession(10000n);
      const b = startSession(10000n);
      const accountRow = () => db.queryOne('SELECT is_slot_busy, current_active_session_id FROM payment_receiving_accounts WHERE id = ?', [accountId]);

      sessionRepo.transitionToTerminal(b.session.id, PaymentStatus.CANCELLED);
      assert.equal(accountRow().is_slot_busy, 1);
      assert.equal(accountRow().current_active_session_id, a.session.id);

      sessionRepo.transitionToTerminal(a.session.id, PaymentStatus.CANCELLED);
      assert.equal(accountRow().is_slot_busy, 0);
      assert.equal(accountRow().current_active_session_id, null);
    });
  });

  describe('when all offsets are in use', () => {
    beforeEach(() => setup(2));

    test('extra sessions queue and are promoted once an amount frees up', () => {
      const live = [startSession(30000n), startSession(30000n), startSession(30000n)];
      assert.ok(live.every(x => x.session.status === PaymentStatus.ACTIVE));

      const waiting = startSession(30000n);
      assert.equal(waiting.session.status, PaymentStatus.QUEUED);
      assert.equal(waiting.result.queuePosition, 1);

      // A paid session frees its amount once the paid reservation lapses; simulate that.
      observe(30001n, 'UTR-PAID');
      db.execute("UPDATE payment_sessions SET completed_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", [live[1].session.id]);

      const promoted = queueEngine.promoteNext(accountId, 300000);
      assert.equal(promoted?.id, waiting.session.id);
      assert.equal(promoted.payableAmountPaise, 30001n);
    });
  });

  describe('with offsets disabled (default)', () => {
    beforeEach(() => setup(0));

    test('keeps the legacy single active slot per receiving account', () => {
      const a = startSession(49900n);
      const b = startSession(20000n);
      assert.equal(a.session.status, PaymentStatus.ACTIVE);
      assert.equal(a.session.payableAmountPaise, 49900n);
      assert.equal(b.session.status, PaymentStatus.QUEUED);

      sessionRepo.transitionToTerminal(a.session.id, PaymentStatus.CANCELLED);
      const promoted = queueEngine.promoteNext(accountId, 300000);
      assert.equal(promoted?.id, b.session.id);
      assert.equal(promoted.payableAmountPaise, 20000n);
    });
  });
});
