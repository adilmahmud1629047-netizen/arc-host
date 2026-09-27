// Pure bKash incoming-SMS parser — no DB, no network, no side effects.
// Supported format ONLY (do not invent other layouts):
//
// You have received Tk 2,470.00 from 01917210879. Fee Tk 0.00.
// Balance Tk 2,633.06. TrxID DFD09UPC86 at 13/06/2026 12:10

const MESSAGE_MAX_LENGTH = 1600;
const TRX_ID_MIN = 4;
const TRX_ID_MAX = 50;
const BDT_PHONE = /^01[3-9]\d{8}$/;
const AMOUNT = /^\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?$|^\d+(?:\.\d{1,2})?$/;
const TRX_ID = /^[A-Za-z0-9]+$/;
const TIMESTAMP = /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/;

const SMS_RE =
  /^You have received Tk ([\d,]+(?:\.\d{1,2})?) from (\d{11})\. Fee Tk ([\d,]+(?:\.\d{1,2})?)\. Balance Tk ([\d,]+(?:\.\d{1,2})?)\. TrxID ([A-Za-z0-9]{4,50}) at (\d{2}\/\d{2}\/\d{4} \d{2}:\d{2})\s*$/;

function unsupported(reason) {
  return { parsed: false, reason: reason || 'UNSUPPORTED_FORMAT' };
}

// "2,470.00" → "2470.00" + integer minor units (paise). Never IEEE floats.
function normalizeMoney(raw) {
  if (typeof raw !== 'string' || !AMOUNT.test(raw)) return null;
  const normalized = raw.replace(/,/g, '');
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const [whole, fracRaw = ''] = normalized.split('.');
  const frac = (fracRaw + '00').slice(0, 2);
  if (whole.length > 10) return null;
  const cents = Number.parseInt(whole, 10) * 100 + Number.parseInt(frac, 10);
  if (!Number.isSafeInteger(cents) || cents < 0) return null;
  return { value: `${Number(whole)}.${frac}`, cents };
}

function isValidTimestamp(text) {
  if (!TIMESTAMP.test(text)) return false;
  const [datePart, timePart] = text.split(' ');
  const [dd, mm, yyyy] = datePart.split('/').map((n) => Number(n));
  const [hh, mi] = timePart.split(':').map((n) => Number(n));
  if (yyyy < 2000 || yyyy > 2100) return false;
  if (mm < 1 || mm > 12) return false;
  if (dd < 1 || dd > 31) return false;
  if (hh > 23 || mi > 59) return false;
  return true;
}

function parseBkashIncomingSms(message) {
  try {
    if (typeof message !== 'string') return unsupported();
    const trimmed = message.trim();
    if (!trimmed || trimmed.length > MESSAGE_MAX_LENGTH) {
      return unsupported('UNSUPPORTED_FORMAT');
    }

    const match = SMS_RE.exec(trimmed);
    if (!match) return unsupported('UNSUPPORTED_FORMAT');

    const [, amountRaw, sender, feeRaw, balanceRaw, transactionId, timestamp] =
      match;

    const amount = normalizeMoney(amountRaw);
    const fee = normalizeMoney(feeRaw);
    const balance = normalizeMoney(balanceRaw);
    if (!amount || !fee || !balance) return unsupported('UNSUPPORTED_FORMAT');
    if (amount.cents <= 0) return unsupported('INVALID_AMOUNT');
    if (!BDT_PHONE.test(sender)) return unsupported('INVALID_SENDER');
    if (
      typeof transactionId !== 'string' ||
      transactionId.length < TRX_ID_MIN ||
      transactionId.length > TRX_ID_MAX ||
      !TRX_ID.test(transactionId)
    ) {
      return unsupported('INVALID_TRANSACTION_ID');
    }
    if (!isValidTimestamp(timestamp)) return unsupported('INVALID_TIMESTAMP');

    return {
      parsed: true,
      provider: 'bkash',
      direction: 'received',
      amount: amount.value,
      amountCents: amount.cents,
      sender,
      fee: fee.value,
      balance: balance.value,
      transactionId,
      receivedAtText: timestamp,
    };
  } catch {
    return unsupported('UNSUPPORTED_FORMAT');
  }
}

module.exports = {
  parseBkashIncomingSms,
  normalizeMoney,
  MESSAGE_MAX_LENGTH,
};
