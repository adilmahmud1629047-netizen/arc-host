const config = require('../config');
const { sendError, sendOk } = require('../utils/respond');
const {
  buildSessionCookieHeader,
  buildClearCookieHeader,
} = require('../utils/cookies');
const authService = require('../services/authService');
const sessionService = require('../services/sessionService');
const { getTokenFromRequest } = require('../middleware/auth');

function clientIp(req) {
  return req.ip || req.socket.remoteAddress || null;
}

async function register(req, res, next) {
  try {
    const { firstName, lastName, email, password } = req.body;
    const user = await authService.register({ firstName, lastName, email, password });
    sendOk(res, { user }, 201);
  } catch (err) {
    next(err);
  }
}

async function login(req, res, next) {
  try {
    const { email, password } = req.body;
    const { user, token, expiresAt } = await authService.login(
      { email, password },
      { ipAddress: clientIp(req), userAgent: req.headers['user-agent'] }
    );

    const maxAgeSeconds = Math.max(
      1,
      Math.floor((expiresAt.getTime() - Date.now()) / 1000)
    );

    res.setHeader(
      'Set-Cookie',
      buildSessionCookieHeader(config.session.cookieName, token, {
        maxAgeSeconds,
        secure: config.isProduction,
      })
    );

    sendOk(res, { user });
  } catch (err) {
    next(err);
  }
}

async function me(req, res, next) {
  try {
    sendOk(res, { user: req.user });
  } catch (err) {
    next(err);
  }
}

async function logout(req, res, next) {
  try {
    const token = getTokenFromRequest(req);

    if (token) {
      await sessionService.destroySession(token);
    }

    res.setHeader(
      'Set-Cookie',
      buildClearCookieHeader(config.session.cookieName, {
        secure: config.isProduction,
      })
    );

    sendOk(res, { message: 'Signed out.' });
  } catch (err) {
    next(err);
  }
}

module.exports = { register, login, me, logout };
