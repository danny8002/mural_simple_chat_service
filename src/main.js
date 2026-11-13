import { createApp, revision } from './app.js';
import { loadConfig } from './config.js';

const log = record => console.log(JSON.stringify({ time: new Date().toISOString(), ...record }));
let config;
try { config = loadConfig(); }
catch (error) {
  log({ event: 'configuration_failed', message: error.message });
  process.exitCode = 1;
}

if (config) {
  const app = createApp(config, { log });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await app.close();
      log({ event: 'service_stopped' });
    } catch {
      log({ event: 'shutdown_failed' });
      process.exitCode = 1;
    }
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await app.listen({ host: '0.0.0.0', port: config.port });
    log({ event: 'service_started', revision: revision(), port: config.port });
  } catch {
    log({ event: 'startup_failed' });
    process.exitCode = 1;
    await stop();
  }
}
