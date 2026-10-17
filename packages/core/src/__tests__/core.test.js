import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidTransition,
  assertValidTransition,
  toPublicOutcome,
  ObservationNormalizer,
  AttributionEngine
} from '../index.js';
import {
  PaymentStatus,
  PublicPaymentOutcome,
  ObserverSource,
  ObservationAttributionStatus
} from '@youpi/common';
import {
  Database,
  runMigrations,
  PaymentSessionRepository,
  ObservationRepository,
  SupportTicketRepository,
  AuditLogRepository,
  CustomerRepository
} from '@youpi/db';

describe('@youpi/core Unit & Integration Tests', () => {
  describe('Payment State Machine', () => {
    test('permits valid transitions and denies illegal transitions', () => {
      assert.equal(isValidTransition(PaymentStatus.INITIATED, PaymentStatus.ACTIVE), true);
      assert.equal(isValidTransition(PaymentStatus.ACTIVE, PaymentStatus.PROCESSING), true);
      assert.equal(isValidTransition(PaymentStatus.PROCESSING, PaymentStatus.SUCCESS), true);
      assert.equal(isValidTransition(PaymentStatus.PROCESSING, PaymentStatus.FAILED), true);
      assert.equal(isValidTransition(PaymentStatus.ACTIVE, PaymentStatus.EXPIRED), true);
      assert.equal(isValidTransition(PaymentStatus.ACTIVE, PaymentStatus.CANCELLED), true);

      // Illegal transitions
      assert.equal(isValidTransition(PaymentStatus.INITIATED, PaymentStatus.SUCCESS), false);
      assert.equal(isValidTransition(PaymentStatus.QUEUED, PaymentStatus.PROCESSING), false);
      assert.equal(isValidTransition(PaymentStatus.EXPIRED, PaymentStatus.SUCCESS), false);
      assert.equal(isValidTransition(PaymentStatus.SUCCESS, PaymentStatus.FAILED), false);

      assert.throws(
        () => assertValidTransition(PaymentStatus.INITIATED, PaymentStatus.SUCCESS),
        /Illegal payment state transition/
      );
    });

    test('maps internal terminal states to public contract outcomes', () => {
      assert.equal(toPublicOutcome(PaymentStatus.SUCCESS), PublicPaymentOutcome.SUCCESS);
      assert.equal(toPublicOutcome(PaymentStatus.FAILED), PublicPaymentOutcome.FAILED);
      assert.equal(toPublicOutcome(PaymentStatus.EXPIRED), PublicPaymentOutcome.EXPIRED);
      assert.equal(toPublicOutcome(PaymentStatus.CANCELLED), PublicPaymentOutcome.CANCELLED);

      assert.throws(
        () => toPublicOutcome(PaymentStatus.ACTIVE),
        /internal non-terminal state/
      );
    });
  });

  describe('Observation Normalizer', () => {
    test('extracts monetary amounts from various notification formats', () => {
      const obs1 = ObservationNormalizer.normalize({
        source: ObserverSource.GMAIL,
        receivingAccountId: 'acc_1',
        rawPayload: {
          snippet: 'Your account has been credited with Rs. 200.00 on 08-Sep-2026. Ref: UTR12345678'
        }
      });
      assert.equal(obs1.amountPaise, 20000n);
      assert.equal(obs1.bankReferenceNumber, 'UTR12345678');
      assert.ok(obs1.fingerprintHash);

      const obs2 = ObservationNormalizer.normalize({
        source: ObserverSource.GOOGLE_MESSAGES,
        receivingAccountId: 'acc_1',
        rawPayload: {
          notificationText: 'Payment of ₹1,500.50 received from user@upi via PhonePe.'
        }
      });
      assert.equal(obs2.amountPaise, 150050n);
      assert.equal(obs2.senderVpa, 'user@upi');
    });

    test('normalizes explicit amount in paise directly', () => {
      const obs = ObservationNormalizer.normalize({
        source: ObserverSource.GOOGLE_MESSAGES,
        receivingAccountId: 'acc_1',
        amountPaise: 49900n,
        rawPayload: { text: 'Bank SMS alert' }
      });
      assert.equal(obs.amountPaise, 49900n);
    });

    test('intelligently extracts amounts without standard currency symbols e.g. "20.00 received"', () => {
      const obs = ObservationNormalizer.normalize({
        source: ObserverSource.GMAIL,
        receivingAccountId: 'acc_1',
        rawPayload: { text: '20.00 received from alt account' }
      });
      assert.equal(obs.amountPaise, 2000n);
    });
  });

  describe('Attribution Engine & Invariants', () => {
    let db;
    let sessionRepo;
    let obsRepo;
    let ticketRepo;
    let auditRepo;
    let customerRepo;
    let defaultMerchant;
    let receivingAccount;
    let attributionEngine;
    let emittedEvents;

    beforeEach(() => {
      db = new Database({ inMemory: true });
      const seed = runMigrations(db);
      defaultMerchant = seed.defaultMerchant;
      receivingAccount = { id: '00000000-0000-0000-0000-000000000002' };

      sessionRepo = new PaymentSessionRepository(db);
      obsRepo = new ObservationRepository(db);
      ticketRepo = new SupportTicketRepository(db);
      auditRepo = new AuditLogRepository(db);
      customerRepo = new CustomerRepository(db);

      emittedEvents = [];
      attributionEngine = new AttributionEngine({
        sessionRepo,
        obsRepo,
        ticketRepo,
        auditRepo,
        eventEmitter: {
          emit: (event, payload) => emittedEvents.push({ event, payload })
        }
      });
    });

    afterEach(() => {
      db.close();
    });

    test('attributes matching observation to active processing session', () => {
      // 1. Create and activate session for ₹200
      const session = sessionRepo.create({
        merchantId: defaultMerchant.id,
        receivingAccountId: receivingAccount.id,
        orderId: 'ORD-101',
        amountPaise: 20000n
      });

      sessionRepo.acquireSlotAtomic(session.id, receivingAccount.id, 300000);
      sessionRepo.transitionToProcessing(session.id, 30000);

      // 2. Normalize and ingest observation for ₹200
      const normObs = ObservationNormalizer.normalize({
        source: ObserverSource.GOOGLE_MESSAGES,
        receivingAccountId: receivingAccount.id,
        amountPaise: 20000n,
        bankReferenceNumber: 'UTR998877',
        rawPayload: { text: 'Received Rs 200' }
      });

      const result = attributionEngine.processObservation(normObs);
      assert.equal(result.attributed, true);
      assert.equal(result.outcomeStatus, PaymentStatus.SUCCESS);
      assert.equal(result.paymentSessionId, session.id);

      // Verify session updated to SUCCESS in DB
      const updatedSession = sessionRepo.findById(session.id);
      assert.equal(updatedSession.status, PaymentStatus.SUCCESS);
      assert.ok(updatedSession.completedAt);

      // Verify event was emitted
      assert.ok(emittedEvents.some(e => e.event === 'PAYMENT.SUCCESS'));
    });

    test('deduplicates multi-channel observations (SMS + Gmail)', () => {
      const session = sessionRepo.create({
        merchantId: defaultMerchant.id,
        receivingAccountId: receivingAccount.id,
        orderId: 'ORD-DEDUP',
        amountPaise: 20000n
      });
      sessionRepo.acquireSlotAtomic(session.id, receivingAccount.id, 300000);
      sessionRepo.transitionToProcessing(session.id, 30000);

      // Method 1: SMS observes ₹200 with UTR111 -> Level 1 (L1)
      const obsSms = ObservationNormalizer.normalize({
        source: ObserverSource.GOOGLE_MESSAGES,
        receivingAccountId: receivingAccount.id,
        amountPaise: 20000n,
        bankReferenceNumber: 'UTR111',
        rawPayload: { text: 'Bank SMS notification Rs 200' }
      });
      const res1 = attributionEngine.processObservation(obsSms);
      assert.equal(res1.attributed, true);
      assert.equal(res1.outcomeStatus, PaymentStatus.SUCCESS);
      assert.equal(res1.verificationLevel, 1);

      // Method 2: Gmail observes same payment from independent channel -> Upgrades to Level 2 (L2 Dual Verification)
      const obsGmail = ObservationNormalizer.normalize({
        source: ObserverSource.GMAIL,
        receivingAccountId: receivingAccount.id,
        amountPaise: 20000n,
        bankReferenceNumber: 'UTR111',
        rawPayload: { text: 'Gmail bank email Rs 200' }
      });
      const res2 = attributionEngine.processObservation(obsGmail);
      assert.equal(res2.attributed, true);
      assert.equal(res2.verificationLevel, 2);

      // Duplicate test: SMS submits same UTR111 again -> MUST be rejected as DUPLICATE_IGNORED!
      const resSmsDup = attributionEngine.processObservation(obsSms);
      assert.equal(resSmsDup.attributed, false);
      assert.equal(resSmsDup.duplicate, true);
      assert.equal(resSmsDup.outcomeStatus, ObservationAttributionStatus.DUPLICATE_IGNORED);

      // Exactly ONE success event was emitted (subsequent multi-channel confirmations were verification upgrades)!
      const successEvents = emittedEvents.filter(e => e.event === 'PAYMENT.SUCCESS');
      assert.equal(successEvents.length, 1);
      const upgradeEvents = emittedEvents.filter(e => e.event === 'PAYMENT.VERIFICATION_UPGRADED');
      assert.equal(upgradeEvents.length, 1);
    });

    test('CRITICAL INVARIANT: Late observation does not attach to a new queued customer', () => {
      // Customer A creates ₹200 session, but it expires
      const customerA = customerRepo.create({
        merchantId: defaultMerchant.id,
        phoneNumber: '9876500001',
        fullName: 'Customer A',
        password: 'PassWord1!'
      });

      const sessionA = sessionRepo.create({
        merchantId: defaultMerchant.id,
        customerId: customerA.id,
        receivingAccountId: receivingAccount.id,
        orderId: 'ORD-EXPIRED-A',
        amountPaise: 20000n
      });
      sessionRepo.acquireSlotAtomic(sessionA.id, receivingAccount.id, 300000);
      sessionRepo.transitionToTerminal(sessionA.id, PaymentStatus.EXPIRED);

      // Customer B arrives for another ₹200 and becomes ACTIVE
      const customerB = customerRepo.create({
        merchantId: defaultMerchant.id,
        phoneNumber: '9876500002',
        fullName: 'Customer B',
        password: 'PassWord2!'
      });

      const sessionB = sessionRepo.create({
        merchantId: defaultMerchant.id,
        customerId: customerB.id,
        receivingAccountId: receivingAccount.id,
        orderId: 'ORD-ACTIVE-B',
        amountPaise: 20000n
      });
      sessionRepo.acquireSlotAtomic(sessionB.id, receivingAccount.id, 300000);

      // Delayed observation arrives for ₹200 with timestamp corresponding to Customer A's window
      const lateObs = ObservationNormalizer.normalize({
        source: ObserverSource.GMAIL,
        receivingAccountId: receivingAccount.id,
        amountPaise: 20000n,
        bankReferenceNumber: 'DELAYED-UTR-A',
        observedAt: new Date(Date.now() - 60000), // observed during A's time
        rawPayload: { text: 'Delayed bank email' }
      });

      // Customer B is in ACTIVE, but has NOT clicked Payment Done (not in PROCESSING).
      // Even if Customer B were in PROCESSING, late observation check detects expired A!
      const lateRes = attributionEngine.processObservation(lateObs);

      // Observation must NOT be given to Customer B!
      assert.equal(lateRes.attributed, false);
      assert.equal(lateRes.lateMatch, true);
      assert.equal(lateRes.paymentSessionId, sessionA.id);

      // Customer B remains ACTIVE, not falsely completed!
      const checkB = sessionRepo.findById(sessionB.id);
      assert.equal(checkB.status, PaymentStatus.ACTIVE);

      // A support ticket must be raised for Customer A's late payment
      const tickets = ticketRepo.findTicketsByCustomer(customerA.id);
      assert.equal(tickets.length, 1);
      assert.ok(tickets[0].subject.includes('LATE PAYMENT DETECTED'));
    });
  });

  describe('Issue #4: Terminal State Invariants and Re-activation Guards', () => {
    let db;
    let sessionRepo;
    let obsRepo;
    let ticketRepo;
    let auditRepo;
    let customerRepo;
    let defaultMerchant;
    let receivingAccount;
    let attributionEngine;
    let emittedEvents;

    beforeEach(() => {
      db = new Database({ inMemory: true });
      const seed = runMigrations(db);
      defaultMerchant = seed.defaultMerchant;
      receivingAccount = { id: '00000000-0000-0000-0000-000000000002' };

      sessionRepo = new PaymentSessionRepository(db);
      obsRepo = new ObservationRepository(db);
      ticketRepo = new SupportTicketRepository(db);
      auditRepo = new AuditLogRepository(db);
      customerRepo = new CustomerRepository(db);

      emittedEvents = [];
      attributionEngine = new AttributionEngine({
        sessionRepo,
        obsRepo,
        ticketRepo,
        auditRepo,
        eventEmitter: {
          emit: (event, payload) => emittedEvents.push({ event, payload })
        }
      });
    });

    afterEach(() => {
      db.close();
    });
    test('strictly forbids all transitions out of terminal states in the state machine', () => {
      const terminalStates = [
        PaymentStatus.SUCCESS,
        PaymentStatus.FAILED,
        PaymentStatus.EXPIRED,
        PaymentStatus.CANCELLED
      ];

      const allStates = [
        PaymentStatus.INITIATED,
        PaymentStatus.QUEUED,
        PaymentStatus.ACTIVE,
        PaymentStatus.PROCESSING,
        PaymentStatus.SUCCESS,
        PaymentStatus.FAILED,
        PaymentStatus.EXPIRED,
        PaymentStatus.CANCELLED
      ];

      for (const terminal of terminalStates) {
        for (const target of allStates) {
          assert.equal(
            isValidTransition(terminal, target),
            false,
            `Expected isValidTransition('${terminal}', '${target}') to be false`
          );
          assert.throws(
            () => assertValidTransition(terminal, target),
            /Illegal payment state transition/
          );
        }
      }
    });

    test('acquireSlotAtomic rejects sessions in terminal status', () => {
      const testCases = [
        PaymentStatus.SUCCESS,
        PaymentStatus.FAILED,
        PaymentStatus.EXPIRED,
        PaymentStatus.CANCELLED
      ];

      for (const status of testCases) {
        const session = sessionRepo.create({
          merchantId: defaultMerchant.id,
          receivingAccountId: receivingAccount.id,
          orderId: `ORD-TERMINAL-${status}`,
          amountPaise: 50000n
        });

        if (status === PaymentStatus.CANCELLED) {
          sessionRepo.transitionToTerminal(session.id, PaymentStatus.CANCELLED);
        } else {
          sessionRepo.acquireSlotAtomic(session.id, receivingAccount.id);
          sessionRepo.transitionToTerminal(session.id, status);
        }

        const terminalSession = sessionRepo.findById(session.id);
        assert.equal(terminalSession.status, status);

        assert.throws(
          () => sessionRepo.acquireSlotAtomic(session.id, receivingAccount.id),
          /Cannot acquire slot for session in terminal status/
        );

        // Status must remain terminal in database
        const afterAttempt = sessionRepo.findById(session.id);
        assert.equal(afterAttempt.status, status);
      }
    });

    test('recordVerificationSource throws on terminal non-success sessions and preserves terminal status', () => {
      const terminalStatuses = [
        PaymentStatus.FAILED,
        PaymentStatus.EXPIRED,
        PaymentStatus.CANCELLED
      ];

      for (const status of terminalStatuses) {
        const session = sessionRepo.create({
          merchantId: defaultMerchant.id,
          receivingAccountId: receivingAccount.id,
          orderId: `ORD-VERIFY-${status}`,
          amountPaise: 40000n
        });
        if (status === PaymentStatus.CANCELLED) {
          sessionRepo.transitionToTerminal(session.id, PaymentStatus.CANCELLED);
        } else {
          sessionRepo.acquireSlotAtomic(session.id, receivingAccount.id);
          sessionRepo.transitionToTerminal(session.id, status);
        }

        assert.throws(
          () => sessionRepo.recordVerificationSource(session.id, ObserverSource.GMAIL, 'obs_fake_123', { finalizeSuccess: true }),
          /Cannot record verification for terminal session in status/
        );

        // Status in database must still be the terminal status
        const unchanged = sessionRepo.findById(session.id);
        assert.equal(unchanged.status, status);
      }
    });

    test('transitionToProcessing rejects terminal sessions and non-active sessions', () => {
      // 1. INITIATED session rejects transition to PROCESSING
      const initiated = sessionRepo.create({
        merchantId: defaultMerchant.id,
        receivingAccountId: receivingAccount.id,
        orderId: 'ORD-PROC-INITIATED',
        amountPaise: 15000n
      });
      assert.throws(
        () => sessionRepo.transitionToProcessing(initiated.id),
        /Illegal payment state transition/
      );

      // 2. QUEUED session rejects transition to PROCESSING
      const activeSess = sessionRepo.create({
        merchantId: defaultMerchant.id,
        receivingAccountId: receivingAccount.id,
        orderId: 'ORD-PROC-ACTIVE',
        amountPaise: 15000n
      });
      sessionRepo.acquireSlotAtomic(activeSess.id, receivingAccount.id);

      const queuedSess = sessionRepo.create({
        merchantId: defaultMerchant.id,
        receivingAccountId: receivingAccount.id,
        orderId: 'ORD-PROC-QUEUED',
        amountPaise: 15000n
      });
      sessionRepo.acquireSlotAtomic(queuedSess.id, receivingAccount.id);
      assert.equal(sessionRepo.findById(queuedSess.id).status, PaymentStatus.QUEUED);

      assert.throws(
        () => sessionRepo.transitionToProcessing(queuedSess.id),
        /Illegal payment state transition/
      );

      // 3. SUCCESS session rejects transition to PROCESSING
      sessionRepo.transitionToTerminal(activeSess.id, PaymentStatus.SUCCESS);
      assert.throws(
        () => sessionRepo.transitionToProcessing(activeSess.id),
        /Illegal payment state transition/
      );

      // 4. CANCELLED session rejects transition to PROCESSING
      const cancelled = sessionRepo.create({
        merchantId: defaultMerchant.id,
        receivingAccountId: receivingAccount.id,
        orderId: 'ORD-PROC-CANCELLED',
        amountPaise: 15000n
      });
      sessionRepo.transitionToTerminal(cancelled.id, PaymentStatus.CANCELLED);
      assert.throws(
        () => sessionRepo.transitionToProcessing(cancelled.id),
        /Illegal payment state transition/
      );

      // 5. EXPIRED session rejects transition to PROCESSING
      const expired = sessionRepo.create({
        merchantId: defaultMerchant.id,
        receivingAccountId: receivingAccount.id,
        orderId: 'ORD-PROC-EXPIRED',
        amountPaise: 15000n
      });
      sessionRepo.acquireSlotAtomic(expired.id, receivingAccount.id);
      sessionRepo.transitionToTerminal(expired.id, PaymentStatus.EXPIRED);
      assert.throws(
        () => sessionRepo.transitionToProcessing(expired.id),
        /Illegal payment state transition/
      );

      // 6. FAILED session rejects transition to PROCESSING
      const failed = sessionRepo.create({
        merchantId: defaultMerchant.id,
        receivingAccountId: receivingAccount.id,
        orderId: 'ORD-PROC-FAILED',
        amountPaise: 15000n
      });
      sessionRepo.acquireSlotAtomic(failed.id, receivingAccount.id);
      sessionRepo.transitionToTerminal(failed.id, PaymentStatus.FAILED);
      assert.throws(
        () => sessionRepo.transitionToProcessing(failed.id),
        /Illegal payment state transition/
      );
    });

    test('AttributionEngine does not revive expired session to SUCCESS and creates support ticket', () => {
      const customer = customerRepo.create({
        merchantId: defaultMerchant.id,
        phoneNumber: '9123456780',
        fullName: 'Late Paying User',
        password: 'Password9!'
      });

      const expiredSession = sessionRepo.create({
        merchantId: defaultMerchant.id,
        customerId: customer.id,
        receivingAccountId: receivingAccount.id,
        orderId: 'ORD-LATE-RECONCILE',
        amountPaise: 75000n
      });

      sessionRepo.acquireSlotAtomic(expiredSession.id, receivingAccount.id);
      sessionRepo.transitionToTerminal(expiredSession.id, PaymentStatus.EXPIRED);

      const lateObs = ObservationNormalizer.normalize({
        source: ObserverSource.GMAIL,
        receivingAccountId: receivingAccount.id,
        amountPaise: 75000n,
        bankReferenceNumber: 'UTR-LATE-999',
        observedAt: new Date(),
        rawPayload: { text: 'Bank alert Rs 750' }
      });

      const result = attributionEngine.processObservation(lateObs);

      assert.equal(result.attributed, false);
      assert.equal(result.lateMatch, true);
      assert.equal(result.paymentSessionId, expiredSession.id);
      assert.equal(result.outcomeStatus, ObservationAttributionStatus.LATE_UNMATCHED);

      // Verify the session status in DB is STILL EXPIRED (not SUCCESS)
      const freshSession = sessionRepo.findById(expiredSession.id);
      assert.equal(freshSession.status, PaymentStatus.EXPIRED);

      // Verify support ticket was created
      const tickets = ticketRepo.findTicketsByCustomer(customer.id);
      assert.ok(tickets.length >= 1);
      const ticket = tickets.find(t => t.paymentId === expiredSession.id);
      assert.ok(ticket);
      assert.ok(ticket.subject.includes('[LATE PAYMENT DETECTED]'));

      // Verify PAYMENT.LATE_DETECTED was emitted and not PAYMENT.SUCCESS
      const lateEvents = emittedEvents.filter(e => e.event === 'PAYMENT.LATE_DETECTED' && e.payload.paymentId === expiredSession.id);
      assert.equal(lateEvents.length, 1);
      const successEvents = emittedEvents.filter(e => e.event === 'PAYMENT.SUCCESS' && e.payload.paymentId === expiredSession.id);
      assert.equal(successEvents.length, 0);
    });
  });
});
