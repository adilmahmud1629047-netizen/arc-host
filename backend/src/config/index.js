const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const config = {
  env: process.env.NODE_ENV || 'development',
  // This project's own fallbacks. The fork inherited `flare_hosting` / `5000`
  // from FLARE HostiNG — never fall back to the original project's database
  // or port when .env is absent.
  port: parseInt(process.env.PORT, 10) || 5001,
  apiPrefix: process.env.API_PREFIX || '/api',
  db: {
    host: process.env.DATABASE_HOST || 'localhost',
    port: parseInt(process.env.DATABASE_PORT, 10) || 5432,
    database: process.env.DATABASE_NAME || 'minecraft_client',
    user: process.env.DATABASE_USER || 'postgres',
    password: process.env.DATABASE_PASSWORD || '',
    max: parseInt(process.env.DATABASE_POOL_MAX, 10) || 10,
    ssl: process.env.DATABASE_SSL === 'true',
    connectionTimeoutMillis:
      parseInt(process.env.DATABASE_CONNECTION_TIMEOUT_MS, 10) || 5000,
  },
  session: {
    cookieName: process.env.SESSION_COOKIE_NAME || 'fh_session',
    ttlSeconds: parseInt(process.env.SESSION_TTL_SECONDS, 10) || 604800,
  },
  rateLimit: {
    loginWindowMs: parseInt(process.env.LOGIN_RATE_LIMIT_WINDOW_MS, 10) || 900000,
    loginMax: parseInt(process.env.LOGIN_RATE_LIMIT_MAX, 10) || 10,
    registerWindowMs:
      parseInt(process.env.REGISTER_RATE_LIMIT_WINDOW_MS, 10) || 3600000,
    registerMax: parseInt(process.env.REGISTER_RATE_LIMIT_MAX, 10) || 10,
    orderCreateWindowMs:
      parseInt(process.env.ORDER_RATE_LIMIT_WINDOW_MS, 10) || 900000,
    orderCreateMax: parseInt(process.env.ORDER_RATE_LIMIT_MAX, 10) || 30,
    paymentCreateWindowMs:
      parseInt(process.env.PAYMENT_RATE_LIMIT_WINDOW_MS, 10) || 900000,
    paymentCreateMax: parseInt(process.env.PAYMENT_RATE_LIMIT_MAX, 10) || 30,
    sslcommerzCallbackWindowMs:
      parseInt(process.env.PAYMENT_CALLBACK_RATE_LIMIT_WINDOW_MS, 10) || 60000,
    sslcommerzCallbackMax:
      parseInt(process.env.PAYMENT_CALLBACK_RATE_LIMIT_MAX, 10) || 120,
    smsSendWindowMs:
      parseInt(process.env.SMS_RATE_LIMIT_WINDOW_MS, 10) || 900000,
    smsSendMax: parseInt(process.env.SMS_RATE_LIMIT_MAX, 10) || 10,
  },
  argon2: {
    memoryCost: parseInt(process.env.ARGON2_MEMORY_COST, 10) || 19456,
    timeCost: parseInt(process.env.ARGON2_TIME_COST, 10) || 2,
    parallelism: parseInt(process.env.ARGON2_PARALLELISM, 10) || 1,
  },
  catalog: {
    currency: process.env.CATALOG_CURRENCY || 'BDT',
    cacheTtlMs: parseInt(process.env.CATALOG_CACHE_TTL_MS, 10) || 30000,
  },
  payments: {
    // `disabled` (default) rejects every payment operation with
    // PAYMENT_PROVIDER_NOT_CONFIGURED. `sslcommerz` enables the
    // SSLCommerz SANDBOX flow — live/production mode is refused by the
    // provider. Credentials come only from the environment (.env).
    provider: (process.env.PAYMENT_PROVIDER || 'disabled').trim().toLowerCase(),
    // bKash inbound SMS auto-verification (step 17). OFF by default.
    // Never enable until real TextBee credentials + webhook delivery work.
    bkash: {
      enabled: process.env.BKASH_PAYMENT_ENABLED === 'true',
      receiverNumber: (process.env.BKASH_RECEIVER_NUMBER || '').trim(),
    },
    // UddoktaPay (https://uddoktapay.readme.io). API base URL = location of
    // your UddoktaPay installation (sandbox: https://sandbox.uddoktapay.com).
    // Credentials come only from the environment (.env) — never source,
    // frontend, logs, or API responses.
    uddoktapay: {
      apiKey: process.env.UDDOKTAPAY_API_KEY || '',
      baseUrl: (process.env.UDDOKTAPAY_API_URL || '')
        .trim()
        .replace(/\/+$/, ''),
      // Public base URL of THIS app — success/fail/cancel callback URLs and
      // the webhook URL are built only from this value (never Host/Origin).
      publicUrl: (process.env.APP_PUBLIC_URL || '').trim().replace(/\/+$/, ''),
      connectTimeoutMs:
        parseInt(process.env.UDDOKTAPAY_CONNECT_TIMEOUT_MS, 10) || 10000,
      requestTimeoutMs:
        parseInt(process.env.UDDOKTAPAY_REQUEST_TIMEOUT_MS, 10) || 15000,
    },
    sslcommerz: {
      storeId: process.env.SSLCOMMERZ_STORE_ID || '',
      storePassword: process.env.SSLCOMMERZ_STORE_PASSWORD || '',
      mode: (process.env.SSLCOMMERZ_MODE || 'sandbox').trim().toLowerCase(),
      baseUrl: (
        process.env.SSLCOMMERZ_BASE_URL || 'https://sandbox-gw.sslcommerz.com'
      )
        .trim()
        .replace(/\/+$/, ''),
      validationUrl:
        (
          process.env.SSLCOMMERZ_VALIDATION_URL ||
          'https://sandbox.sslcommerz.com/validator/api/validationserverAPI.php'
        ).trim(),
      // Public base URL of THIS app — success/fail/cancel/IPN URLs are built
      // only from this value (never from Host/Origin/Referer). Must be an
      // https URL reachable from the internet for real IPN delivery;
      // localhost cannot receive SSLCommerz IPN.
      publicUrl: (process.env.APP_PUBLIC_URL || '').trim().replace(/\/+$/, ''),
      connectTimeoutMs:
        parseInt(process.env.SSLCOMMERZ_CONNECT_TIMEOUT_MS, 10) || 10000,
      requestTimeoutMs:
        parseInt(process.env.SSLCOMMERZ_REQUEST_TIMEOUT_MS, 10) || 15000,
    },
  },
  sms: {
    // `disabled` (default) refuses every send with
    // SMS_PROVIDER_NOT_CONFIGURED. `textbee` enables the TextBee REST API
    // (https://textbee.dev/docs). The API key lives only here — never in
    // source, frontend, logs, or API responses.
    // Incoming webhooks are gated by TEXTBEE_WEBHOOK_SECRET (not the API key)
    // and never mark orders paid by themselves.
    provider: (process.env.SMS_PROVIDER || 'disabled').trim().toLowerCase(),
    textbee: {
      apiKey: process.env.TEXTBEE_API_KEY || '',
      baseUrl: (
        process.env.TEXTBEE_BASE_URL || 'https://api.textbee.dev/api/v1'
      )
        .trim()
        .replace(/\/+$/, ''),
      deviceId: (process.env.TEXTBEE_DEVICE_ID || '').trim(),
      gatewayId: (process.env.TEXTBEE_GATEWAY_ID || '').trim(),
      // TEST-ONLY fixture. When NODE_ENV=test and no secret is supplied, the
      // server gets a deterministic HMAC secret so the client suite can verify
      // signed webhooks without any real TextBee credential or manual env var.
      // MUST match TEST_SECRET in backend/test/textbee-webhook.test.js and
      // backend/test/bkash-payment.test.js. Never applies to development or
      // production — those keep '' (webhook refuses with 503).
      webhookSecret:
        process.env.TEXTBEE_WEBHOOK_SECRET ||
        (process.env.NODE_ENV === 'test'
          ? 'textbee-webhook-secret-for-tests-20chars-min'
          : ''),
      simSubscriptionId: (() => {
        const raw = (process.env.TEXTBEE_SIM_SUBSCRIPTION_ID || '').trim();
        if (!raw) return null;
        const value = Number(raw);
        return Number.isInteger(value) && value > 0 ? value : null;
      })(),
      timeoutMs: parseInt(process.env.SMS_REQUEST_TIMEOUT_MS, 10) || 10000,
    },
  },
  provisioning: {
    // `disabled` (default) refuses every provisioning operation with
    // PROVISIONING_PROVIDER_NOT_CONFIGURED — no service instance is ever
    // created while disabled. `proxmox` / `whm` select a real provider;
    // Step 12 providers refuse with PROVISIONING_NOT_IMPLEMENTED (no
    // external API call is made). Credentials live only in the environment —
    // never in source, the database, logs, or API responses.
    provider: (process.env.PROVISIONING_PROVIDER || 'disabled')
      .trim()
      .toLowerCase(),
    proxmox: {
      apiUrl: process.env.PROXMOX_API_URL || '',
      tokenId: process.env.PROXMOX_TOKEN_ID || '',
      tokenSecret: process.env.PROXMOX_TOKEN_SECRET || '',
      node: process.env.PROXMOX_NODE || '',
    },
    whm: {
      apiUrl: process.env.WHM_API_URL || '',
      apiToken: process.env.WHM_API_TOKEN || '',
      username: process.env.WHM_USERNAME || '',
    },
  },
};

config.isProduction = config.env === 'production';

module.exports = config;
