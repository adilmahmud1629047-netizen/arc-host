const { sendOk, sendError } = require('../utils/respond');
const planService = require('../services/planService');

function handleServiceResult(res, result) {
  if (result.ok) {
    return sendOk(res, result.plan);
  }
  if (result.reason === 'invalid') {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid plan slug.', [
      'Slug must be lowercase letters, digits, and hyphens.',
    ]);
  }
  return sendError(res, 404, 'PLAN_NOT_FOUND', 'Plan not found.');
}

const HOSTING_CATEGORIES = ['web', 'minecraft'];

async function listHosting(req, res, next) {
  try {
    let category = null;
    if (req.query.category !== undefined && req.query.category !== '') {
      category = String(req.query.category);
      if (!HOSTING_CATEGORIES.includes(category)) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [
          `category must be one of: ${HOSTING_CATEGORIES.join(', ')}.`,
        ]);
      }
    }
    const plans = await planService.listHostingPlans(category);
    sendOk(res, plans);
  } catch (err) {
    next(err);
  }
}

async function listVps(req, res, next) {
  try {
    const plans = await planService.listVpsPlans();
    sendOk(res, plans);
  } catch (err) {
    next(err);
  }
}

async function getHostingBySlug(req, res, next) {
  try {
    const result = await planService.getHostingPlanBySlug(req.params.slug);
    handleServiceResult(res, result);
  } catch (err) {
    next(err);
  }
}

async function getVpsBySlug(req, res, next) {
  try {
    const result = await planService.getVpsPlanBySlug(req.params.slug);
    handleServiceResult(res, result);
  } catch (err) {
    next(err);
  }
}

module.exports = { listHosting, listVps, getHostingBySlug, getVpsBySlug };
