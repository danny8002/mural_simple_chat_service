function required(env, name, minimum = 1) {
  const value = env[name];
  if (typeof value !== 'string' || value.length < minimum || value.length > 512 ||
      !/^[\x21-\x7e]+$/.test(value)) {
    throw new Error(`Invalid or missing ${name}.`);
  }
  return value;
}

function azureOrigin(env, name) {
  const value = required(env, name);
  let url;
  try { url = new URL(value); } catch { throw new Error(`Invalid ${name}.`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      url.pathname !== '/' || url.search || url.hash ||
      !/^[a-z0-9][a-z0-9-]*\.(?:openai\.azure\.com|services\.ai\.azure\.com)$/.test(url.hostname)) {
    throw new Error(`Invalid ${name}; use an Azure HTTPS resource origin without a path.`);
  }
  return url.origin;
}

function deployment(env, name) {
  const value = required(env, name);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) throw new Error(`Invalid ${name}.`);
  return value;
}

export function loadConfig(env = process.env) {
  const port = env.PORT ?? '10000';
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('Invalid PORT.');
  if (env.ENABLE_WEB_SEARCH !== undefined && !['true', 'false'].includes(env.ENABLE_WEB_SEARCH)) {
    throw new Error('Invalid ENABLE_WEB_SEARCH.');
  }
  return Object.freeze({
    port: Number(port),
    apiKey: required(env, 'APIKEY', 32),
    signingSecret: required(env, 'SESSION_SIGNING_SECRET', 32),
    liveOrigin: azureOrigin(env, 'AZURE_LIVE_ENDPOINT'),
    liveKey: required(env, 'AZURE_LIVE_API_KEY', 20),
    liveDeployment: deployment(env, 'AZURE_LIVE_DEPLOYMENT'),
    responsesOrigin: azureOrigin(env, 'AZURE_RESPONSES_ENDPOINT'),
    responsesKey: required(env, 'AZURE_RESPONSES_API_KEY', 20),
    responsesDeployment: deployment(env, 'AZURE_RESPONSES_DEPLOYMENT'),
    searchEnabled: env.ENABLE_WEB_SEARCH === 'true',
  });
}
