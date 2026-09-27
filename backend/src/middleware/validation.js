const { sendError } = require('../utils/respond');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function passwordPolicyError(value) {
  if (value.length < 12) {
    return 'Password must be at least 12 characters long.';
  }
  if (value.length > 128) {
    return 'Password must be at most 128 characters long.';
  }
  if (!/[a-z]/.test(value)) {
    return 'Password must contain at least one lowercase letter.';
  }
  if (!/[A-Z]/.test(value)) {
    return 'Password must contain at least one uppercase letter.';
  }
  if (!/[0-9]/.test(value)) {
    return 'Password must contain at least one digit.';
  }
  return null;
}

function fieldLabel(label) {
  return label || 'Field';
}

function validateBody(rules) {
  return (req, res, next) => {
    const body = req.body;

    if (
      body === undefined ||
      body === null ||
      typeof body !== 'object' ||
      Array.isArray(body)
    ) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', [
        'Request body must be a JSON object.',
      ]);
    }

    const details = [];
    const output = {};
    const allowedKeys = new Set(Object.keys(rules));

    for (const key of Object.keys(body)) {
      if (!allowedKeys.has(key)) {
        details.push(`Unexpected field: ${key}.`);
      }
    }

    for (const [field, rule] of Object.entries(rules)) {
      const label = fieldLabel(rule.label);
      let value = body[field];

      if (value === undefined || value === null || value === '') {
        if (rule.required) {
          details.push(`${label} is required.`);
        }
        continue;
      }

      if (typeof value !== 'string') {
        details.push(`${label} must be a string.`);
        continue;
      }

      if (rule.trim) {
        value = value.trim();
      }

      if (rule.required && value === '') {
        details.push(`${label} is required.`);
        continue;
      }

      if (rule.min !== undefined && value.length < rule.min) {
        details.push(
          rule.minMessage || `${label} must be at least ${rule.min} characters.`
        );
        continue;
      }

      if (rule.max !== undefined && value.length > rule.max) {
        details.push(
          rule.maxMessage || `${label} must be at most ${rule.max} characters.`
        );
        continue;
      }

      if (rule.pattern && !rule.pattern.test(value)) {
        details.push(rule.patternMessage || `${label} is invalid.`);
        continue;
      }

      if (rule.validate) {
        const customError = rule.validate(value);
        if (customError) {
          details.push(customError);
          continue;
        }
      }

      output[field] = value;
    }

    if (details.length > 0) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid request.', details);
    }

    req.body = output;
    next();
  };
}

const registerRules = {
  firstName: {
    label: 'First name',
    required: true,
    type: 'string',
    trim: true,
    min: 1,
    max: 100,
  },
  lastName: {
    label: 'Last name',
    required: true,
    type: 'string',
    trim: true,
    min: 1,
    max: 100,
  },
  email: {
    label: 'Email',
    required: true,
    type: 'string',
    trim: true,
    min: 3,
    max: 320,
    pattern: EMAIL_PATTERN,
    patternMessage: 'Email must be a valid email address.',
    normalizeLower: true,
  },
  password: {
    label: 'Password',
    required: true,
    type: 'string',
    min: 1,
    max: 128,
    validate: passwordPolicyError,
  },
};

const loginRules = {
  email: {
    label: 'Email',
    required: true,
    type: 'string',
    trim: true,
    min: 3,
    max: 320,
    pattern: EMAIL_PATTERN,
    patternMessage: 'Email must be a valid email address.',
  },
  password: {
    label: 'Password',
    required: true,
    type: 'string',
    min: 1,
    max: 128,
  },
};

function applyEmailNormalization(rules) {
  return (req, res, next) => {
    if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
      for (const [field, rule] of Object.entries(rules)) {
        if (rule.normalizeLower && typeof req.body[field] === 'string') {
          req.body[field] = req.body[field].trim().toLowerCase();
        }
      }
    }
    next();
  };
}

const validateRegister = [
  applyEmailNormalization(registerRules),
  validateBody(registerRules),
];

const validateLogin = [
  applyEmailNormalization(loginRules),
  validateBody(loginRules),
];

module.exports = {
  validateBody,
  validateRegister,
  validateLogin,
  passwordPolicyError,
  EMAIL_PATTERN,
};
