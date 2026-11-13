import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import Fastify from 'fastify';
import { AzureProvider } from './azure.js';
import { ServiceError } from './errors.js';
import { Admission, authorized, CloseHandles } from './state.js';
import { closeInput, helperInput, voiceInput } from './validation.js';

function safeError(error) {
  if (error instanceof ServiceError) return error;
  if (error?.code === 'FST_ERR_CTP_BODY_TOO_LARGE') return new ServiceError('request_too_large', 413);
  if (['FST_ERR_CTP_INVALID_JSON_BODY', 'FST_ERR_CTP_EMPTY_JSON_BODY'].includes(error?.code)) return new ServiceError('invalid_request');
  if (error?.statusCode === 415) return new ServiceError('unsupported_content_type', 415);
  return new ServiceError('internal', 500);
}

export function createApp(config, { provider = new AzureProvider(config), log = record => console.log(JSON.stringify(record)), now } = {}) {
  const app = Fastify({
    logger: false, bodyLimit: 65_536, requestTimeout: 15_000, connectionTimeout: 60_000,
    keepAliveTimeout: 5_000, forceCloseConnections: 'idle', genReqId: () => randomUUID(),
  });
  const admission = new Admission(now), handles = new CloseHandles(config, now);
  const helpers = new Set();
  let draining = false, windowStart = 0, requests = 0;
  const emit = (event, details = {}) => log({ time: new Date().toISOString(), event, ...details });
  const envelope = (request, error) => ({ error: { code: error.code, reference: request.id, retryable: error.retryable } });
  const operation = request => request.routeOptions.url ?? 'unmatched';
  const failure = (request, error) => {
    emit('request_failed', { operation: operation(request), reference: request.id, status: error.status, code: error.code });
  };
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
    if (request.routeOptions.url === '/healthz') return;
    if (!authorized(request.headers.authorization, config.apiKey)) throw new ServiceError('unauthorized', 401);
    if (draining) throw new ServiceError('service_stopping', 503);
    const time = Date.now();
    if (time >= windowStart + 60_000) { windowStart = time; requests = 0; }
    if (++requests > 120) throw new ServiceError('rate_limit', 429);
  });
  app.setErrorHandler((error, request, reply) => {
    const safe = safeError(error);
    failure(request, safe);
    reply.code(safe.status).header('X-Request-Reference', request.id).send(envelope(request, safe));
  });
  app.setNotFoundHandler(() => { throw new ServiceError('not_found', 404); });
  app.addHook('onResponse', async (request, reply) => {
    emit('request_completed', { operation: operation(request), reference: request.id,
      status: reply.statusCode, durationMilliseconds: Math.round(reply.elapsedTime) });
  });
  app.addHook('preClose', async () => {
    draining = true;
    for (const controller of helpers) controller.abort();
  });

  app.get('/healthz', async () => ({ status: 'ok', protocolVersion: 1 }));
  app.get('/v1/capabilities', async () => ({
    protocolVersion: 1, voice: true, helpers: true, webSearch: config.searchEnabled,
  }));
  app.post('/v1/live/sessions', { bodyLimit: 98_304 }, async (request, reply) => {
    const input = voiceInput(request.body);
    const leave = admission.enter('voice', input.requestID);
    let delivered = false;
    const cleanup = async result => {
      try {
        const closed = await provider.close(result.session.id);
        emit('cancelled_create_cleanup', { reference: request.id, confirmed: closed.confirmed });
      } catch {
        emit('cancelled_create_cleanup', { reference: request.id, confirmed: false });
      }
    };
    try {
      if (reply.raw.destroyed) throw new ServiceError('create_cancelled', 503);
      const result = await provider.create(input);
      if (reply.raw.destroyed || draining) {
        await cleanup(result);
        throw new ServiceError('create_cancelled', 503);
      }
      reply.raw.once('finish', () => { delivered = true; });
      reply.raw.once('close', () => { if (!delivered) void cleanup(result); });
      return { ...result, closeHandle: handles.issue(result.session.id) };
    } finally { leave(); }
  });
  app.post('/v1/live/close', async request => {
    const id = handles.verify(closeInput(request.body));
    const leave = admission.enter('close');
    try {
      const result = await provider.close(id);
      if (!result.confirmed) emit('voice_close_unconfirmed', { reference: request.id });
      return { status: result.confirmed ? 'confirmed' : 'unconfirmed' };
    } finally { leave(); }
  });
  app.post('/v1/responses', async (request, reply) => {
    const input = helperInput(request.body, config.searchEnabled);
    const leave = admission.enter('helper', input.requestID);
    const controller = new AbortController();
    helpers.add(controller);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)]);
    const disconnected = () => { if (!reply.raw.writableFinished) controller.abort(); };
    reply.raw.on('close', disconnected);
    try {
      if (!input.stream) return await provider.respond(input, signal);
      let started = false;
      try {
        for await (const event of provider.stream(input, signal)) {
          signal.throwIfAborted();
          if (!started) {
            reply.hijack(); started = true;
            reply.raw.writeHead(200, {
              'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store',
              'X-Content-Type-Options': 'nosniff', 'X-Accel-Buffering': 'no',
            });
          }
          if (!reply.raw.write(`data: ${JSON.stringify(event)}\n\n`)) {
            await once(reply.raw, 'drain', { signal });
          }
        }
        reply.raw.end();
        return reply;
      } catch (error) {
        if (!started) throw error;
        const safe = error instanceof ServiceError ? error :
          new ServiceError(signal.aborted ? 'provider_request_aborted' : 'internal', 502);
        failure(request, safe);
        if (!reply.raw.destroyed) reply.raw.end(`data: ${JSON.stringify({ type: 'error', ...envelope(request, safe) })}\n\n`);
        return reply;
      }
    } finally {
      helpers.delete(controller);
      controller.abort();
      reply.raw.removeListener('close', disconnected);
      leave();
    }
  });
  return app;
}

export function revision(env = process.env) {
  const value = env.RENDER_GIT_COMMIT;
  return typeof value === 'string' && /^[a-f0-9]{7,64}$/i.test(value) ? value : 'local';
}
