// bKash incoming-SMS verification — reuses payment_transactions +
// markOrderPaidFromVerifiedPayment. Never issues raw UPDATE orders SET paid.
//
// Gate: config.payments.bkash.enabled (BKASH_PAYMENT_ENABLED, default false).

const config = require('../../config');
const { getClient } = require('../../config/database');
const paymentModel = require('../../models/paymentModel');
const orderModel = require('../../models/orderModel');
const smsIncomingModel = require('../../models/smsIncomingModel');
const { parseBkashIncomingSms } = require('./bkashSmsParser');
const { markOrderPaidFromVerifiedPayment } = require('./paymentService');

const PROVIDER = 'bkash';
const CURRENCY = 'BDT';
const AWAITING = 'awaiting_payment';

function moneyEqualDb(a, b) {
  // Both sides are NUMERIC strings / values — compare via integer cents.
  const toCents = (v) => {
    const s = String(v);
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
    const [w, f = ''] = s.split('.');
    return Number(w) * 100 + Number((f + '00').slice(0, 2));
  };
  const ca = toCents(a);
  const cb = toCents(b);
  return ca !== null && cb !== null && ca === cb;
}

async function findAwaitingOrdersByAmount(amountStr) {
  const { query } = require('../../config/database');
  const { rows } = await query(
    `SELECT id, user_id, order_number, amount, currency, status
     FROM orders
     WHERE status = $1 AND currency = $2 AND amount = $3::numeric
     ORDER BY created_at ASC, id ASC
     LIMIT 20`,
    [AWAITING, CURRENCY, amountStr]
  );
  return rows;
}

/**
 * Process one stored sms_incoming_events row (already inserted).
 * Always safe when BKASH_PAYMENT_ENABLED is false — leaves status untouched
 * beyond the original 'received'.
 *
 * @returns { status, verification } — status for the SMS row + safe detail
 */
async function processBkashIncomingPayment(smsEventId, message) {
  if (!config.payments.bkash.enabled) {
    // Record the gate reason on the stored event (status stays 'received').
    await smsIncomingModel
      .updateProcessing(smsEventId, {
        status: 'received',
        metadata: { reason: 'BKASH_DISABLED', attempted: false },
      })
      .catch(() => {});
    return { status: 'received', verification: { attempted: false, reason: 'BKASH_DISABLED' } };
  }

  const parsed = parseBkashIncomingSms(message);
  if (!parsed.parsed) {
    await smsIncomingModel.updateProcessing(smsEventId, {
      status: 'received',
      metadata: { parsed: false, parseReason: parsed.reason },
    });
    return {
      status: 'received',
      verification: { attempted: true, parsed: false, reason: parsed.reason },
    };
  }

  await smsIncomingModel.updateProcessing(smsEventId, {
    status: 'parsed',
    metadata: {
      parsed: true,
      provider: 'bkash',
      amount: parsed.amount,
      transactionId: parsed.transactionId,
      sender: parsed.sender,
      receivedAtText: parsed.receivedAtText,
      fee: parsed.fee,
    },
  });

  const receiver = config.payments.bkash.receiverNumber || null;

  // Duplicate TrxID first — never re-pay a different order / amount.
  const existing = await paymentModel.findByProviderTransactionId(
    PROVIDER,
    parsed.transactionId
  );
  if (existing) {
    if (!moneyEqualDb(existing.amount, parsed.amount)) {
      await smsIncomingModel.updateProcessing(smsEventId, {
        status: 'rejected',
        metadata: {
          parsed: true,
          reason: 'TRX_AMOUNT_MISMATCH',
          transactionId: parsed.transactionId,
          amount: parsed.amount,
        },
      });
      return {
        status: 'rejected',
        verification: {
          attempted: true,
          parsed: true,
          reason: 'TRX_AMOUNT_MISMATCH',
          transactionId: parsed.transactionId,
        },
      };
    }
    if (existing.status === 'successful') {
      // Replay of an already-verified TrxID — idempotent success for SMS.
      await smsIncomingModel.updateProcessing(smsEventId, {
        status: 'verified',
        metadata: {
          parsed: true,
          reason: 'TRX_REPLAY',
          transactionId: parsed.transactionId,
          orderId: existing.order_id,
          amount: parsed.amount,
        },
      });
      return {
        status: 'verified',
        verification: {
          attempted: true,
          parsed: true,
          reason: 'TRX_REPLAY',
          transactionId: parsed.transactionId,
          orderId: existing.order_id,
          replayed: true,
        },
      };
    }
    // Same TrxID stuck in non-successful state for another order attempt.
    await smsIncomingModel.updateProcessing(smsEventId, {
      status: 'rejected',
      metadata: {
        parsed: true,
        reason: 'TRX_ALREADY_USED',
        transactionId: parsed.transactionId,
        orderId: existing.order_id,
      },
    });
    return {
      status: 'rejected',
      verification: {
        attempted: true,
        parsed: true,
        reason: 'TRX_ALREADY_USED',
        transactionId: parsed.transactionId,
      },
    };
  }

  const candidates = await findAwaitingOrdersByAmount(parsed.amount);
  if (candidates.length === 0) {
    await smsIncomingModel.updateProcessing(smsEventId, {
      status: 'rejected',
      metadata: {
        parsed: true,
        reason: 'NO_MATCHING_ORDER',
        amount: parsed.amount,
        transactionId: parsed.transactionId,
      },
    });
    return {
      status: 'rejected',
      verification: {
        attempted: true,
        parsed: true,
        reason: 'NO_MATCHING_ORDER',
        amount: parsed.amount,
      },
    };
  }

  if (candidates.length > 1) {
    await smsIncomingModel.updateProcessing(smsEventId, {
      status: 'ambiguous',
      metadata: {
        parsed: true,
        reason: 'AMBIGUOUS_AMOUNT',
        amount: parsed.amount,
        candidateCount: candidates.length,
        transactionId: parsed.transactionId,
        receiverNumber: receiver,
      },
    });
    return {
      status: 'ambiguous',
      verification: {
        attempted: true,
        parsed: true,
        reason: 'AMBIGUOUS_AMOUNT',
        candidateCount: candidates.length,
        amount: parsed.amount,
      },
    };
  }

  const order = candidates[0];
  if (order.status !== AWAITING) {
    await smsIncomingModel.updateProcessing(smsEventId, {
      status: 'rejected',
      metadata: { parsed: true, reason: 'ORDER_NOT_AWAITING', orderId: order.id },
    });
    return {
      status: 'rejected',
      verification: { attempted: true, parsed: true, reason: 'ORDER_NOT_AWAITING' },
    };
  }

  // Create payment row with provider_transaction_id set (unique index = race
  // guard), then hand off to the existing trusted transition.
  let paymentRow;
  try {
    paymentRow = await paymentModel.create({
      orderId: order.id,
      userId: order.user_id,
      provider: PROVIDER,
      amount: order.amount,
      currency: order.currency,
      status: 'initiated',
      paymentMethod: 'bkash_sms',
      providerTransactionId: parsed.transactionId,
    });
  } catch (err) {
    if (err && err.code === '23505') {
      // Concurrent insert won the unique (provider, provider_transaction_id).
      const winner = await paymentModel.findByProviderTransactionId(
        PROVIDER,
        parsed.transactionId
      );
      if (winner && winner.status === 'successful') {
        await smsIncomingModel.updateProcessing(smsEventId, {
          status: 'verified',
          metadata: {
            parsed: true,
            reason: 'TRX_REPLAY',
            transactionId: parsed.transactionId,
            orderId: winner.order_id,
          },
        });
        return {
          status: 'verified',
          verification: {
            attempted: true,
            parsed: true,
            reason: 'TRX_REPLAY',
            replayed: true,
            transactionId: parsed.transactionId,
          },
        };
      }
      await smsIncomingModel.updateProcessing(smsEventId, {
        status: 'rejected',
        metadata: {
          parsed: true,
          reason: 'TRX_ALREADY_USED',
          transactionId: parsed.transactionId,
        },
      });
      return {
        status: 'rejected',
        verification: {
          attempted: true,
          parsed: true,
          reason: 'TRX_ALREADY_USED',
          transactionId: parsed.transactionId,
        },
      };
    }
    throw err;
  }

  try {
    const result = await markOrderPaidFromVerifiedPayment({
      paymentId: paymentRow.id,
      amount: String(order.amount),
      currency: order.currency,
      providerTransactionId: parsed.transactionId,
      bankTranId: parsed.transactionId,
      riskLevel: undefined,
      riskFlag: undefined,
    });

    await smsIncomingModel.updateProcessing(smsEventId, {
      status: 'verified',
      metadata: {
        parsed: true,
        reason: result.replayed ? 'TRX_REPLAY' : 'VERIFIED',
        transactionId: parsed.transactionId,
        orderId: order.id,
        orderNumber: order.order_number,
        paymentId: result.payment.id,
        amount: parsed.amount,
        receiverNumber: receiver,
      },
    });

    return {
      status: 'verified',
      verification: {
        attempted: true,
        parsed: true,
        reason: result.replayed ? 'TRX_REPLAY' : 'VERIFIED',
        transactionId: parsed.transactionId,
        orderId: order.id,
        orderNumber: order.order_number,
        paymentId: result.payment.id,
        amount: parsed.amount,
        replayed: Boolean(result.replayed),
      },
    };
  } catch (err) {
    // Roll back orphan payment row if transition failed before commit.
    if (err && (err.status === 400 || err.status === 409)) {
      await paymentModel.markTerminal(paymentRow.id, 'failed').catch(() => {});
      const reason =
        err.code === 'ORDER_ALREADY_PAID'
          ? 'ORDER_ALREADY_PAID'
          : err.code === 'ORDER_NOT_PAYABLE'
            ? 'ORDER_NOT_PAYABLE'
            : 'VERIFICATION_FAILED';
      await smsIncomingModel.updateProcessing(smsEventId, {
        status: 'rejected',
        metadata: {
          parsed: true,
          reason,
          transactionId: parsed.transactionId,
          orderId: order.id,
        },
      });
      return {
        status: 'rejected',
        verification: {
          attempted: true,
          parsed: true,
          reason,
          transactionId: parsed.transactionId,
        },
      };
    }
    throw err;
  }
}

module.exports = {
  processBkashIncomingPayment,
  PROVIDER,
  CURRENCY,
};
