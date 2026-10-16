import crypto from 'node:crypto';
import { PaymentStatus, PaymentMethod } from '@youpi/common';

const DEFAULT_MAX_AMOUNT_OFFSET_PAISE = 0; // legacy single-slot unless configured
// A payable amount stays reserved after its session ends so that a late bank alert
// for it is never credited to a newer session that happens to reuse the same amount.
const UNPAID_AMOUNT_RESERVATION_MS = 30 * 60 * 1000; // matches the late-observation window
const PAID_AMOUNT_RESERVATION_MS = 5 * 60 * 1000; // covers duplicate alerts from a second observer

export class PaymentSessionRepository {
  /**
   * @param {import('../database.js').Database} db
   * @param {{ maxAmountOffsetPaise?: number }} [options]
   *   maxAmountOffsetPaise: how many paise may be added to an order amount to make it unique
   *   on a receiving account, allowing that many extra concurrent ACTIVE sessions per amount.
   *   0 (the default) keeps the legacy single-active-slot behaviour. Defaults to env
   *   YOUPI_MAX_AMOUNT_OFFSET_PAISE, else 0. 99 allows up to 100 concurrent sessions per amount.
   */
  constructor(db, options = {}) {
    this.db = db;
    const configured = options.maxAmountOffsetPaise ?? process.env.YOUPI_MAX_AMOUNT_OFFSET_PAISE ?? DEFAULT_MAX_AMOUNT_OFFSET_PAISE;
    const parsed = Number.parseInt(configured, 10);
    this.maxAmountOffsetPaise = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_AMOUNT_OFFSET_PAISE;
  }

  create(data) {
    const id = data.id || crypto.randomUUID();
    const now = new Date().toISOString();
    const metadata = typeof data.metadata === 'object' ? JSON.stringify(data.metadata) : (data.metadata || '{}');

    const sql = `
      INSERT INTO payment_sessions (
        id, merchant_id, customer_id, receiving_account_id, order_id,
        amount_paise, currency, method, status, queue_position,
        return_url, idempotency_key, device_id, verification_level, verification_sources,
        verification_tag, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '[]', 'UNVERIFIED', ?, ?, ?)
    `;

    this.db.execute(sql, [
      id,
      data.merchantId,
      data.customerId || null,
      data.receivingAccountId || null,
      data.orderId,
      Number(data.amountPaise),
      data.currency || 'INR',
      data.method || PaymentMethod.UPI,
      data.status || PaymentStatus.INITIATED,
      data.queuePosition || 0,
      data.returnUrl || null,
      data.idempotencyKey || null,
      data.deviceId || null,
      metadata,
      now,
      now
    ]);

    return this.findById(id);
  }

  findById(id) {
    const row = this.db.queryOne('SELECT * FROM payment_sessions WHERE id = ?', [id]);
    if (!row) return null;
    return this.mapRow(row);
  }

  findByOrderId(merchantId, orderId) {
    const row = this.db.queryOne(
      'SELECT * FROM payment_sessions WHERE merchant_id = ? AND order_id = ?',
      [merchantId, orderId]
    );
    if (!row) return null;
    return this.mapRow(row);
  }

  findByCustomerId(customerId) {
    const rows = this.db.query(
      'SELECT * FROM payment_sessions WHERE customer_id = ? ORDER BY created_at DESC',
      [customerId]
    );
    return rows.map(r => this.mapRow(r));
  }

  findByMerchantId(merchantId, limit = 50) {
    const rows = this.db.query(
      'SELECT * FROM payment_sessions WHERE merchant_id = ? ORDER BY created_at DESC LIMIT ?',
      [merchantId, limit]
    );
    return rows.map(r => this.mapRow(r));
  }

  /**
   * Atomic slot acquisition transaction for UPI payments.
   *
   * Bank alerts carry no order reference, so a credit can only be attributed by its exact
   * amount. Each ACTIVE/PROCESSING session on a receiving account therefore gets a payable
   * amount that is unique on that account: the order amount plus the smallest free offset
   * of 0..maxAmountOffsetPaise paise (e.g. Rs 499.00, Rs 499.01, Rs 499.02 ...).
   * If no offset is free the session is QUEUED, as before.
   *
   * With maxAmountOffsetPaise = 0 this is the legacy invariant: only ONE active or
   * processing session per receiving account, all others QUEUED.
   */
  acquireSlotAtomic(sessionId, receivingAccountId, durationMs = 300000) {
    return this.db.transaction(() => {
      const now = new Date();
      const nowIso = now.toISOString();

      const liveRows = this.db.query(`
        SELECT id, status, expires_at, processing_expires_at, amount_paise, payable_amount_paise
        FROM payment_sessions
        WHERE receiving_account_id = ? AND status IN (?, ?)
      `, [receivingAccountId, PaymentStatus.ACTIVE, PaymentStatus.PROCESSING]);

      const activeRows = [];
      for (const row of liveRows) {
        if (this.isStaleRow(row, now)) {
          const terminalStatus = row.status === PaymentStatus.PROCESSING ? PaymentStatus.FAILED : PaymentStatus.EXPIRED;
          this.db.execute(`
            UPDATE payment_sessions
            SET status = ?, completed_at = ?, updated_at = ?
            WHERE id = ?
          `, [terminalStatus, nowIso, nowIso, row.id]);
        } else {
          activeRows.push(row);
        }
      }

      // CRITICAL GUARD: If THIS session is already active, do not demote it to QUEUED!
      const self = activeRows.find(r => r.id === sessionId);
      if (self) {
        return {
          status: PaymentStatus.ACTIVE,
          queuePosition: 0,
          expiresAt: self.expires_at ? new Date(self.expires_at) : new Date(now.getTime() + durationMs),
          payableAmountPaise: BigInt(self.payable_amount_paise ?? self.amount_paise)
        };
      }

      const sessionRow = this.db.queryOne('SELECT amount_paise, queue_position FROM payment_sessions WHERE id = ?', [sessionId]);
      const payableAmountPaise = sessionRow
        ? this.allocatePayableAmount(receivingAccountId, Number(sessionRow.amount_paise), activeRows, now)
        : null;

      if (payableAmountPaise !== null) {
        const expiresAt = new Date(now.getTime() + durationMs).toISOString();

        this.db.execute(`
          UPDATE payment_sessions
          SET status = ?, slot_acquired_at = ?, expires_at = ?, queue_position = 0, payable_amount_paise = ?, updated_at = ?
          WHERE id = ?
        `, [PaymentStatus.ACTIVE, nowIso, expiresAt, payableAmountPaise, nowIso, sessionId]);

        // Mark receiving account as busy
        this.db.execute(`
          UPDATE payment_receiving_accounts
          SET is_slot_busy = 1, current_active_session_id = ?, updated_at = ?
          WHERE id = ?
        `, [sessionId, nowIso, receivingAccountId]);

        return {
          status: PaymentStatus.ACTIVE,
          queuePosition: 0,
          expiresAt: new Date(expiresAt),
          payableAmountPaise: BigInt(payableAmountPaise)
        };
      }

      // No unique amount available: place in QUEUED
      let queuePosition = sessionRow?.queue_position;
      if (!queuePosition || queuePosition <= 0) {
        const posRow = this.db.queryOne(`
          SELECT COALESCE(MAX(queue_position), 0) + 1 AS next_pos
          FROM payment_sessions
          WHERE receiving_account_id = ? AND status = ?
        `, [receivingAccountId, PaymentStatus.QUEUED]);

        queuePosition = posRow ? posRow.next_pos : 1;
      }

      this.db.execute(`
        UPDATE payment_sessions
        SET status = ?, queue_position = ?, updated_at = ?
        WHERE id = ?
      `, [PaymentStatus.QUEUED, queuePosition, nowIso, sessionId]);

      return {
        status: PaymentStatus.QUEUED,
        queuePosition,
        expiresAt: null
      };
    });
  }

  /**
   * Picks the smallest payable amount (orderAmount + 0..maxAmountOffsetPaise) that no live or
   * recently ended session on the receiving account is using. Returns null if none is free.
   * Must be called inside a transaction.
   * @param {string} receivingAccountId
   * @param {number} amountPaise
   * @param {Array<{ amount_paise: number, payable_amount_paise: number | null }>} activeRows
   * @param {Date} now
   * @returns {number | null}
   */
  allocatePayableAmount(receivingAccountId, amountPaise, activeRows, now) {
    if (this.maxAmountOffsetPaise === 0) {
      return activeRows.length === 0 ? amountPaise : null;
    }

    const maxPayable = amountPaise + this.maxAmountOffsetPaise;
    const unpaidSince = new Date(now.getTime() - UNPAID_AMOUNT_RESERVATION_MS).toISOString();
    const paidSince = new Date(now.getTime() - PAID_AMOUNT_RESERVATION_MS).toISOString();
    const recentRows = this.db.query(`
      SELECT COALESCE(payable_amount_paise, amount_paise) AS payable
      FROM payment_sessions
      WHERE receiving_account_id = ?
        AND slot_acquired_at IS NOT NULL
        AND COALESCE(payable_amount_paise, amount_paise) BETWEEN ? AND ?
        AND (
          (status IN (?, ?, ?) AND updated_at >= ?)
          OR (status = ? AND COALESCE(completed_at, updated_at) >= ?)
        )
    `, [
      receivingAccountId, amountPaise, maxPayable,
      PaymentStatus.EXPIRED, PaymentStatus.FAILED, PaymentStatus.CANCELLED, unpaidSince,
      PaymentStatus.SUCCESS, paidSince
    ]);

    const taken = new Set(recentRows.map(r => Number(r.payable)));
    for (const row of activeRows) {
      taken.add(Number(row.payable_amount_paise ?? row.amount_paise));
    }

    for (let candidate = amountPaise; candidate <= maxPayable; candidate++) {
      if (!taken.has(candidate)) return candidate;
    }
    return null;
  }

  isStaleRow(row, now = new Date()) {
    return (row.status === PaymentStatus.ACTIVE && row.expires_at && new Date(row.expires_at) <= now) ||
      (row.status === PaymentStatus.PROCESSING && row.processing_expires_at && new Date(row.processing_expires_at) <= now);
  }

  /**
   * Keeps the receiving account's slot flags pointing at a live session, if any remain.
   * Must be called inside a transaction.
   */
  refreshAccountSlot(receivingAccountId, nowIso = new Date().toISOString()) {
    const remaining = this.db.queryOne(`
      SELECT id FROM payment_sessions
      WHERE receiving_account_id = ? AND status IN (?, ?)
      ORDER BY slot_acquired_at DESC
      LIMIT 1
    `, [receivingAccountId, PaymentStatus.ACTIVE, PaymentStatus.PROCESSING]);

    this.db.execute(`
      UPDATE payment_receiving_accounts
      SET is_slot_busy = ?, current_active_session_id = ?, updated_at = ?
      WHERE id = ?
    `, [remaining ? 1 : 0, remaining ? remaining.id : null, nowIso, receivingAccountId]);
  }

  /**
   * Transitions an ACTIVE session to PROCESSING upon customer clicking Payment Done.
   * Starts independent 30-second verification timer.
   */
  transitionToProcessing(sessionId, durationMs = 30000) {
    return this.db.transaction(() => {
      const session = this.findById(sessionId);
      if (!session) throw new Error(`Session not found: ${sessionId}`);

      // Idempotency: if already processing, return existing
      if (session.status === PaymentStatus.PROCESSING) {
        return session;
      }

      if (session.status !== PaymentStatus.ACTIVE) {
        throw new Error(`Cannot transition to PROCESSING from status: ${session.status}`);
      }

      const now = new Date();
      const nowIso = now.toISOString();
      const processingExpiresAt = new Date(now.getTime() + durationMs).toISOString();

      this.db.execute(`
        UPDATE payment_sessions
        SET status = ?, processing_started_at = ?, processing_expires_at = ?, updated_at = ?
        WHERE id = ? AND status = ?
      `, [PaymentStatus.PROCESSING, nowIso, processingExpiresAt, nowIso, sessionId, PaymentStatus.ACTIVE]);

      return this.findById(sessionId);
    });
  }

  /**
   * Transitions session to terminal state (SUCCESS, FAILED, EXPIRED, CANCELLED).
   * Atomically releases receiving account slot.
   */
  transitionToTerminal(sessionId, targetStatus, options = {}) {
    return this.db.transaction(() => {
      const session = this.findById(sessionId);
      if (!session) throw new Error(`Session not found: ${sessionId}`);

      // Terminal states are final
      const terminalStates = [
        PaymentStatus.SUCCESS,
        PaymentStatus.FAILED,
        PaymentStatus.EXPIRED,
        PaymentStatus.CANCELLED
      ];

      if (terminalStates.includes(session.status)) {
        return session; // already terminal, idempotent
      }

      const now = new Date().toISOString();
      const attributedObsId = options.attributedObservationId || session.attributedObservationId || null;

      let metadata = session.metadata || {};
      if (typeof metadata === 'string') {
        try { metadata = JSON.parse(metadata); } catch { metadata = {}; }
      }
      if (options.reason) {
        metadata = { ...metadata, cancelledReason: options.reason };
      }
      if (options.replacedByDeviceId) {
        metadata = { ...metadata, replacedByDeviceId: options.replacedByDeviceId };
      }
      if (options.replacedBySessionId) {
        metadata = { ...metadata, replacedBySessionId: options.replacedBySessionId };
      }

      this.db.execute(`
        UPDATE payment_sessions
        SET status = ?, completed_at = ?, attributed_observation_id = ?, metadata = ?, updated_at = ?
        WHERE id = ?
      `, [targetStatus, now, attributedObsId, JSON.stringify(metadata), now, sessionId]);

      // Release this session's slot on the receiving account (other sessions may still hold theirs)
      if (session.receivingAccountId) {
        this.refreshAccountSlot(session.receivingAccountId, now);
      }

      return this.findById(sessionId);
    });
  }

  findCurrentActiveOrProcessing(receivingAccountId) {
    const row = this.db.queryOne(`
      SELECT * FROM payment_sessions
      WHERE receiving_account_id = ? AND status IN (?, ?)
      LIMIT 1
    `, [receivingAccountId, PaymentStatus.ACTIVE, PaymentStatus.PROCESSING]);

    if (!row) return null;
    const now = new Date();
    const isStale = (row.status === PaymentStatus.ACTIVE && row.expires_at && new Date(row.expires_at) <= now) ||
      (row.status === PaymentStatus.PROCESSING && row.processing_expires_at && new Date(row.processing_expires_at) <= now);
    if (isStale) {
      const terminalStatus = row.status === PaymentStatus.PROCESSING ? PaymentStatus.FAILED : PaymentStatus.EXPIRED;
      this.transitionToTerminal(row.id, terminalStatus);
      return null;
    }
    return this.mapRow(row);
  }

  /**
   * Finds the live (ACTIVE or PROCESSING) session on a receiving account whose payable
   * amount is exactly amountPaise.
   * @param {string} receivingAccountId
   * @param {bigint | number} amountPaise
   */
  findActiveByPayableAmount(receivingAccountId, amountPaise) {
    const row = this.db.queryOne(`
      SELECT * FROM payment_sessions
      WHERE receiving_account_id = ? AND status IN (?, ?)
        AND COALESCE(payable_amount_paise, amount_paise) = ?
      ORDER BY slot_acquired_at DESC
      LIMIT 1
    `, [receivingAccountId, PaymentStatus.ACTIVE, PaymentStatus.PROCESSING, Number(amountPaise)]);

    if (!row) return null;
    if (this.isStaleRow(row)) {
      const terminalStatus = row.status === PaymentStatus.PROCESSING ? PaymentStatus.FAILED : PaymentStatus.EXPIRED;
      this.transitionToTerminal(row.id, terminalStatus);
      return null;
    }
    return this.mapRow(row);
  }

  findCurrentActiveOrProcessingForMerchant(merchantId) {
    if (!merchantId) return null;
    const row = this.db.queryOne(`
      SELECT * FROM payment_sessions
      WHERE merchant_id = ? AND status IN (?, ?)
      ORDER BY created_at DESC
      LIMIT 1
    `, [merchantId, PaymentStatus.ACTIVE, PaymentStatus.PROCESSING]);

    if (!row) return null;
    const now = new Date();
    const isStale = (row.status === PaymentStatus.ACTIVE && row.expires_at && new Date(row.expires_at) <= now) ||
      (row.status === PaymentStatus.PROCESSING && row.processing_expires_at && new Date(row.processing_expires_at) <= now);
    if (isStale) {
      const terminalStatus = row.status === PaymentStatus.PROCESSING ? PaymentStatus.FAILED : PaymentStatus.EXPIRED;
      this.transitionToTerminal(row.id, terminalStatus);
      return null;
    }
    return this.mapRow(row);
  }

  findActiveForCustomer(customerId, excludeSessionId = null) {
    if (!customerId) return null;
    let query = `
      SELECT * FROM payment_sessions
      WHERE customer_id = ? AND status IN (?, ?, ?)
    `;
    const params = [customerId, PaymentStatus.ACTIVE, PaymentStatus.PROCESSING, PaymentStatus.QUEUED];
    if (excludeSessionId) {
      query += ` AND id != ? `;
      params.push(excludeSessionId);
    }
    query += ` ORDER BY created_at DESC LIMIT 1 `;
    const row = this.db.queryOne(query, params);

    if (!row) return null;
    const now = new Date();
    const isStale = (row.status === PaymentStatus.ACTIVE && row.expires_at && new Date(row.expires_at) <= now) ||
      (row.status === PaymentStatus.PROCESSING && row.processing_expires_at && new Date(row.processing_expires_at) <= now);
    if (isStale) {
      const terminalStatus = row.status === PaymentStatus.PROCESSING ? PaymentStatus.FAILED : PaymentStatus.EXPIRED;
      this.transitionToTerminal(row.id, terminalStatus);
      return null;
    }
    return this.mapRow(row);
  }

  findActiveForDevice(deviceId, excludeSessionId = null) {
    if (!deviceId) return null;
    let query = `
      SELECT * FROM payment_sessions
      WHERE device_id = ? AND status IN (?, ?, ?)
    `;
    const params = [deviceId, PaymentStatus.ACTIVE, PaymentStatus.PROCESSING, PaymentStatus.QUEUED];
    if (excludeSessionId) {
      query += ` AND id != ? `;
      params.push(excludeSessionId);
    }
    query += ` ORDER BY created_at DESC LIMIT 1 `;
    const row = this.db.queryOne(query, params);

    if (!row) return null;
    const now = new Date();
    const isStale = (row.status === PaymentStatus.ACTIVE && row.expires_at && new Date(row.expires_at) <= now) ||
      (row.status === PaymentStatus.PROCESSING && row.processing_expires_at && new Date(row.processing_expires_at) <= now);
    if (isStale) {
      const terminalStatus = row.status === PaymentStatus.PROCESSING ? PaymentStatus.FAILED : PaymentStatus.EXPIRED;
      this.transitionToTerminal(row.id, terminalStatus);
      return null;
    }
    return this.mapRow(row);
  }

  findConflictingActiveSession({ customerId = null, deviceId = null, excludeSessionId = null }) {
    if (!customerId && !deviceId) return null;
    let query = `
      SELECT * FROM payment_sessions
      WHERE status IN (?, ?, ?)
    `;
    const params = [PaymentStatus.ACTIVE, PaymentStatus.PROCESSING, PaymentStatus.QUEUED];
    if (excludeSessionId) {
      query += ` AND id != ? `;
      params.push(excludeSessionId);
    }
    if (customerId && deviceId) {
      query += ` AND (customer_id = ? OR device_id = ?) `;
      params.push(customerId, deviceId);
    } else if (customerId) {
      query += ` AND customer_id = ? `;
      params.push(customerId);
    } else {
      query += ` AND device_id = ? `;
      params.push(deviceId);
    }
    query += ` ORDER BY created_at DESC LIMIT 1 `;
    const row = this.db.queryOne(query, params);

    if (!row) return null;
    const now = new Date();
    const isStale = (row.status === PaymentStatus.ACTIVE && row.expires_at && new Date(row.expires_at) <= now) ||
      (row.status === PaymentStatus.PROCESSING && row.processing_expires_at && new Date(row.processing_expires_at) <= now);
    if (isStale) {
      const terminalStatus = row.status === PaymentStatus.PROCESSING ? PaymentStatus.FAILED : PaymentStatus.EXPIRED;
      this.transitionToTerminal(row.id, terminalStatus);
      return null;
    }
    return this.mapRow(row);
  }

  findAllActiveOrPendingForCustomer(customerId) {
    if (!customerId) return [];
    const rows = this.db.query(`
      SELECT * FROM payment_sessions
      WHERE customer_id = ? AND status IN (?, ?, ?, ?)
      ORDER BY created_at DESC
    `, [customerId, PaymentStatus.ACTIVE, PaymentStatus.PROCESSING, PaymentStatus.QUEUED, PaymentStatus.INITIATED]);
    return rows.map(r => this.mapRow(r));
  }

  findQueuedSessions(receivingAccountId) {
    const rows = this.db.query(`
      SELECT * FROM payment_sessions
      WHERE receiving_account_id = ? AND status = ?
      ORDER BY queue_position ASC, created_at ASC
    `, [receivingAccountId, PaymentStatus.QUEUED]);

    return rows.map(r => this.mapRow(r));
  }

  getNextQueuedSession(receivingAccountId) {
    const row = this.db.queryOne(`
      SELECT * FROM payment_sessions
      WHERE receiving_account_id = ? AND status = ?
      ORDER BY queue_position ASC, created_at ASC
      LIMIT 1
    `, [receivingAccountId, PaymentStatus.QUEUED]);

    if (!row) return null;
    return this.mapRow(row);
  }

  /**
   * Re-indexes remaining queued sessions after a promotion.
   */
  reindexQueue(receivingAccountId) {
    const queued = this.findQueuedSessions(receivingAccountId);
    let pos = 1;
    for (const session of queued) {
      this.db.execute(`
        UPDATE payment_sessions SET queue_position = ?, updated_at = ?
        WHERE id = ?
      `, [pos++, new Date().toISOString(), session.id]);
    }
  }

  findRecentlyExpiredOrFailed(receivingAccountId, sinceDate) {
    const rows = this.db.query(`
      SELECT * FROM payment_sessions
      WHERE receiving_account_id = ?
        AND status IN (?, ?)
        AND updated_at >= ?
      ORDER BY updated_at DESC
      LIMIT 20
    `, [receivingAccountId, PaymentStatus.EXPIRED, PaymentStatus.FAILED, sinceDate.toISOString()]);

    return rows.map(r => this.mapRow(r));
  }

  /**
   * Records observation confirmation, calculates 2-level verification tier (SMS + Gmail),
   * updates the verification tag, and transitions to SUCCESS if level >= 1 and shouldFinalize is true.
   * @param {string} sessionId
   * @param {string} source E.g. 'GMAIL', 'GOOGLE_MESSAGES'
   * @param {string} observationId
   * @param {{ finalizeSuccess?: boolean }} [options={}]
   * @returns {{ session: any, level: number, sources: string[], tag: string, isFirstSuccess: boolean }}
   */
  recordVerificationSource(sessionId, source, observationId, options = {}) {
    return this.db.transaction(() => {
      const session = this.findById(sessionId);
      if (!session) throw new Error(`Payment session not found: ${sessionId}`);

      // Read current verification sources
      const sourcesSet = new Set(session.verificationSources || []);
      sourcesSet.add(source);
      const sources = Array.from(sourcesSet);

      const level = Math.min(2, sources.length); // 1 or 2 (2-Layer Engine: SMS + Gmail)
      const sourceLabels = sources.map(s => {
        if (s === 'GOOGLE_MESSAGES') return 'SMS';
        if (s === 'GMAIL') return 'Gmail';
        return s;
      });

      let tag = `Single Verification (${sourceLabels.join(', ')})`;
      if (level >= 2) {
        tag = `Dual Verification (${sourceLabels.join(' + ')})`;
      }

      const shouldFinalize = options.finalizeSuccess !== false;
      const isFirstSuccess = shouldFinalize && session.status !== PaymentStatus.SUCCESS && level >= 1;
      const targetStatus = shouldFinalize && level >= 1 ? PaymentStatus.SUCCESS : session.status;
      const now = new Date().toISOString();

      this.db.execute(`
        UPDATE payment_sessions
        SET status = ?,
            verification_level = ?,
            verification_sources = ?,
            verification_tag = ?,
            attributed_observation_id = COALESCE(attributed_observation_id, ?),
            completed_at = COALESCE(completed_at, ?),
            updated_at = ?
        WHERE id = ?
      `, [
        targetStatus,
        level,
        JSON.stringify(sources),
        tag,
        observationId,
        targetStatus === PaymentStatus.SUCCESS ? now : null,
        now,
        sessionId
      ]);

      // If this transition made it terminal SUCCESS, release slot on receiving account
      if (targetStatus === PaymentStatus.SUCCESS && session.receivingAccountId) {
        this.refreshAccountSlot(session.receivingAccountId, now);
      }

      const updated = this.findById(sessionId);
      return {
        session: updated,
        level,
        sources,
        tag,
        isFirstSuccess
      };
    });
  }

  bindDevice(sessionId, deviceId) {
    const now = new Date().toISOString();
    this.db.execute(
      'UPDATE payment_sessions SET device_id = ?, updated_at = ? WHERE id = ?',
      [deviceId, now, sessionId]
    );
    return this.findById(sessionId);
  }

  mapRow(row) {
    return {
      id: row.id,
      merchantId: row.merchant_id,
      customerId: row.customer_id,
      receivingAccountId: row.receiving_account_id,
      orderId: row.order_id,
      amountPaise: BigInt(row.amount_paise),
      // The exact amount the customer is asked to pay; unique per receiving account while live
      payableAmountPaise: BigInt(row.payable_amount_paise ?? row.amount_paise),
      currency: row.currency,
      method: row.method,
      status: row.status,
      queuePosition: row.queue_position,
      slotAcquiredAt: row.slot_acquired_at ? new Date(row.slot_acquired_at) : null,
      expiresAt: row.expires_at ? new Date(row.expires_at) : null,
      processingStartedAt: row.processing_started_at ? new Date(row.processing_started_at) : null,
      processingExpiresAt: row.processing_expires_at ? new Date(row.processing_expires_at) : null,
      completedAt: row.completed_at ? new Date(row.completed_at) : null,
      returnUrl: row.return_url,
      attributedObservationId: row.attributed_observation_id,
      idempotencyKey: row.idempotency_key,
      deviceId: row.device_id || null,
      verificationLevel: row.verification_level !== undefined && row.verification_level !== null ? Number(row.verification_level) : 0,
      verificationSources: JSON.parse(row.verification_sources || '[]'),
      verificationTag: row.verification_tag || 'UNVERIFIED',
      metadata: JSON.parse(row.metadata || '{}'),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    };
  }
}

