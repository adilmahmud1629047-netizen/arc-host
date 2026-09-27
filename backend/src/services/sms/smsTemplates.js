// Generic transactional SMS templates — layer only, NOT wired into any
// workflow yet (no OTP generation, no registration/payment/auth sends in this
// step). Future steps compose a template string here, then hand it to the
// central SMS service (backend/src/services/sms/).
//
// Templates must never embed credentials, API keys, or session tokens; they
// only interpolate caller-supplied business values (codes, order numbers).

const verificationCode = ({ code, expiresInMinutes = 10 } = {}) =>
  `FLARE Hosting verification code: ${code}. Valid for ${expiresInMinutes} minutes. We will never ask you for this code.`;

const passwordReset = ({ code, expiresInMinutes = 15 } = {}) =>
  `FLARE Hosting password reset code: ${code}. Valid for ${expiresInMinutes} minutes. If you did not request this, ignore this message.`;

const orderConfirmation = ({ orderNumber } = {}) =>
  `FLARE Hosting: order ${orderNumber} has been received. Track it from your dashboard.`;

const paymentNotification = ({ orderNumber, outcome } = {}) =>
  `FLARE Hosting: payment ${outcome} for order ${orderNumber}. Details are in your dashboard.`;

const serviceNotification = ({ summary } = {}) =>
  `FLARE Hosting service notice: ${summary}`;

module.exports = {
  verificationCode,
  passwordReset,
  orderConfirmation,
  paymentNotification,
  serviceNotification,
};
