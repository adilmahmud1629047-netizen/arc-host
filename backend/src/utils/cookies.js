function parseCookies(header) {
  const cookies = {};
  if (!header || typeof header !== 'string') {
    return cookies;
  }

  const parts = header.split(';');
  for (const part of parts) {
    const separator = part.indexOf('=');
    if (separator === -1) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    if (!name) {
      continue;
    }
    let value = part.slice(separator + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

function buildSessionCookieHeader(name, token, { maxAgeSeconds, secure }) {
  const parts = [
    `${name}=${encodeURIComponent(token)}`,
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
    'HttpOnly',
    'SameSite=Lax',
  ];

  if (secure) {
    parts.push('Secure');
  }

  return parts.join('; ');
}

function buildClearCookieHeader(name, { secure }) {
  const parts = [`${name}=`, 'Path=/', 'Max-Age=0', 'HttpOnly', 'SameSite=Lax'];
  if (secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

module.exports = {
  parseCookies,
  buildSessionCookieHeader,
  buildClearCookieHeader,
};
