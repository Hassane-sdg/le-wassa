function localSmokeBaseUrl(value, expectedPort) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('A non-empty local smoke-test URL is required.');
  }
  if (!Number.isInteger(expectedPort) || expectedPort < 1 || expectedPort > 65535) {
    throw new Error('The isolated smoke-test API port is invalid.');
  }

  let target;
  try {
    target = new URL(value);
  } catch {
    throw new Error('The smoke-test URL is malformed.');
  }

  if (target.protocol !== 'http:') {
    throw new Error('The isolated smoke-test API must use HTTP on loopback.');
  }
  if (!['localhost', '127.0.0.1'].includes(target.hostname.toLowerCase())) {
    throw new Error('Smoke tests may target loopback only.');
  }
  if (target.username || target.password || target.pathname !== '/' || target.search || target.hash) {
    throw new Error('The smoke-test URL must contain only a local API origin.');
  }
  if (Number(target.port || 80) !== expectedPort) {
    throw new Error('The smoke-test URL must use the isolated API port.');
  }

  return `http://127.0.0.1:${expectedPort}`;
}

module.exports = { localSmokeBaseUrl };
