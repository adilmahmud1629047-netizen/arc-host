const express = require('express');
const adminController = require('../controllers/adminController');
const adminPlanController = require('../controllers/adminPlanController');
const { requireAdmin, rejectUnexpectedBody } = require('../middleware/admin');
const { requireSameOrigin } = require('../middleware/csrf');

const router = express.Router();

// Admin foundation: same-origin + role gate for every route. The original
// endpoints are GET-only (no JSON body); the manual payment review routes,
// the product CRUD routes and the customer account controls below are the
// exception and are therefore registered BEFORE rejectUnexpectedBody — they
// still run behind requireSameOrigin + requireAdmin, and their bodies are
// validated field-by-field in the controllers (only whitelisted keys are
// ever read; amount/status/verified/role are never accepted from clients).
router.use(requireSameOrigin);
router.use(requireAdmin);

router.post('/payments/:id/verify', adminController.verifyPayment);
router.post('/payments/:id/reject', adminController.rejectPayment);
// Dual verification (STEP 47): automatic UddoktaPay re-verification and the
// manual gateway fallback. Both settle only through paymentService's single
// authoritative path; bodies are field-validated in the controller.
router.post(
  '/payments/:id/verify-uddoktapay',
  adminController.verifyPaymentWithGateway
);
router.post(
  '/payments/:id/manual-verify',
  adminController.manualVerifyPayment
);

// Customer account controls (STEP 48): status transitions and an Argon2id
// password reset only. No delete routes, no role changes, no order/payment
// mutations — bodies are field-validated in the controllers (empty object
// only), session revocation is server-side, and the currently authenticated
// admin cannot suspend their own account.
router.post('/customers/:id/suspend', adminController.suspendCustomer);
router.post('/customers/:id/reactivate', adminController.reactivateCustomer);
router.post(
  '/customers/:id/reset-password',
  adminController.resetCustomerPassword
);

// Product management (STEP 45) — see adminPlanController for validation.
router.get('/plans', adminPlanController.listPlans);
router.get('/plans/:productType/:id', adminPlanController.getPlan);
router.post('/plans', adminPlanController.createPlan);
router.patch('/plans/:productType/:id', adminPlanController.updatePlan);
router.delete('/plans/:productType/:id', adminPlanController.deletePlan);

router.use(rejectUnexpectedBody);

router.get('/me', adminController.me);
router.get('/health', adminController.health);
router.get('/dashboard', adminController.dashboard);
router.get('/orders', adminController.listOrders);
router.get('/orders/:id', adminController.getOrder);
router.get('/customers', adminController.listCustomers);
router.get('/customers/:id', adminController.getCustomer);
router.get('/customers/:id/orders', adminController.listCustomerOrders);
router.get('/customers/:id/payments', adminController.listCustomerPayments);
router.get('/payments', adminController.listManualPayments);
router.get('/payments/:id', adminController.getPaymentDetail);
router.get('/sms/incoming', adminController.listIncomingSms);

module.exports = router;
