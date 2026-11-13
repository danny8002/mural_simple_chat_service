import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { createApp } from '../src/app.js';
import { AzureProvider } from '../src/azure.js';
import { assessmentSchema, auth, completed, config, delta, frame, helper, result, voice } from './support.js';

async function fakeAzure(t) {
  const calls = [], sockets = [];
  let handler = async (_request, response, body) => {
    if (body.transport) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ session: { id: 'session_test' }, transport: { type: 'webrtc', sdp: 'v=0\r\nanswer' } }));
    } else if (body.stream) {
      response.setHeader('content-type', 'text/event-stream');
      response.end(frame(delta) + frame(completed));
    } else {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(result));
    }
  };
  let onCommand = socket => {
    socket.send(JSON.stringify({ type: 'session.closed', session: { id: 'session_test' }, usage: { seconds: 15 } }));
  };
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls.push({ path: request.url, headers: request.headers, body });
    await handler(request, response, body);
  });
  const websocket = new WebSocketServer({ server });
  websocket.on('connection', (socket, request) => {
    sockets.push({ path: request.url, headers: request.headers, commands: [] });
    const entry = sockets.at(-1);
    socket.on('message', data => {
      const command = JSON.parse(data.toString());
      entry.commands.push(command);
      onCommand(socket, command);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const provider = new AzureProvider(config, {
    request: (url, options) => {
      const target = new URL(url);
      assert.ok([config.liveOrigin, config.responsesOrigin].includes(target.origin));
      assert.equal(options.redirect, 'error');
      return fetch(`${origin}${target.pathname}`, options);
    },
    socket: (url, options) => {
      assert.equal(url.origin, config.liveOrigin.replace('https:', 'wss:'));
      return new WebSocket(`${origin.replace('http:', 'ws:')}${url.pathname}`, options);
    },
  });
  t.after(async () => {
    for (const client of websocket.clients) client.terminate();
    await new Promise(resolve => websocket.close(resolve));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return {
    provider, calls, sockets,
    setHandler(value) { handler = value; },
    setCommandHandler(value) { onCommand = value; },
  };
}

test('Azure transport negotiates SDP, pins deployments/auth and uses sideband terminal closure', async t => {
  const fake = await fakeAzure(t);
  const input = voice();
  const answer = await fake.provider.create(input);
  assert.equal(answer.session.id, 'session_test');
  assert.equal(fake.calls[0].path, '/openai/v1/live/sessions');
  assert.equal(fake.calls[0].headers.authorization, `Bearer ${config.liveKey}`);
  assert.equal(fake.calls[0].body.session.model, config.liveDeployment);
  assert.equal(fake.calls[0].body.session.store, undefined);
  assert.equal(fake.calls[0].body.session.audio.output.voice, 'marin');
  assert.deepEqual(fake.calls[0].body.session.input, input.history);
  assert.deepEqual(fake.calls[0].body.session.delegation, { type: 'client' });
  assert.deepEqual(await fake.provider.close('session_test'), { confirmed: true });
  assert.equal(fake.sockets[0].path, '/openai/v1/live/sessions/session_test/attach');
  assert.equal(fake.sockets[0].commands[0].type, 'session.close');
  assert.equal(fake.sockets[0].headers.authorization, `Bearer ${config.liveKey}`);
  assert.equal(fake.sockets[0].commands.length, 1);
});

test('Azure helper JSON and streaming preserve output while using only the text resource key', async t => {
  const fake = await fakeAzure(t);
  assert.deepEqual(await fake.provider.respond(helper(), AbortSignal.timeout(2000)), result);
  const call = fake.calls[0];
  assert.equal(call.path, '/openai/v1/responses');
  assert.equal(call.headers['api-key'], config.responsesKey);
  assert.equal(call.headers.authorization, undefined);
  assert.equal(call.body.model, config.responsesDeployment);
  assert.equal(call.body.max_output_tokens, 1400);
  assert.deepEqual(call.body.reasoning, { effort: 'low' });
  assert.equal(call.body.store, false);
  assert.equal(call.body.background, false);
  assert.equal(call.body.prompt_cache_options, undefined);
  assert.equal(call.body.tools, undefined);
  assert.deepEqual(await Array.fromAsync(fake.provider.stream({ ...helper(), stream: true }, AbortSignal.timeout(2000))), [delta, completed]);
  await fake.provider.respond({ ...helper(), purpose: 'assessment', schema: assessmentSchema }, AbortSignal.timeout(2000));
  assert.equal(fake.calls[2].body.max_output_tokens, 2200);
  assert.deepEqual(fake.calls[2].body.text.format.schema, assessmentSchema);
  assert.equal(fake.calls[2].body.text.format.strict, true);
});

test('Azure ambiguous create and explicit rejection never retry or leak upstream errors', async t => {
  const fake = await fakeAzure(t);
  for (const [status, code] of [[400, 'provider_create_rejected'], [408, 'provider_create_uncertain'], [500, 'provider_create_uncertain']]) {
    fake.setHandler(async (_request, response) => {
      response.writeHead(status); response.end('private-provider-error-body');
    });
    await assert.rejects(fake.provider.create(voice()), error => error.code === code && !error.message.includes('private-provider'));
  }
  fake.setHandler(async (_request, response) => response.end('not json'));
  await assert.rejects(fake.provider.create(voice()), /provider_create_uncertain/);
  fake.setHandler(async (request) => request.socket.destroy());
  await assert.rejects(fake.provider.create(voice()), /provider_create_uncertain/);
  assert.equal(fake.calls.length, 5);
});

test('Azure helper rejects oversized JSON, incomplete status, wrong content type and upstream failure', async t => {
  const fake = await fakeAzure(t);
  const cases = [
    { status: 429, type: 'application/json', body: 'private-provider-error-body', code: 'provider_rate_limited' },
    { status: 200, type: 'text/html', body: '<html>not a response</html>', code: 'provider_response_invalid' },
    { status: 200, type: 'application/json', body: JSON.stringify({ status: 'incomplete', output: [] }), code: 'provider_response_incomplete' },
    { status: 200, type: 'application/json', body: 'x'.repeat(1_048_577), code: 'provider_response_too_large' },
  ];
  for (const item of cases) {
    fake.setHandler(async (_request, response) => {
      response.writeHead(item.status, { 'content-type': item.type }); response.end(item.body);
    });
    await assert.rejects(fake.provider.respond(helper(), AbortSignal.timeout(2000)), error => error.code === item.code);
  }
  assert.equal(fake.calls.length, cases.length);
});

test('transport disconnect, error, wrong session and malformed final usage do not confirm closure', async t => {
  const fake = await fakeAzure(t);
  const commands = [
    socket => socket.close(),
    socket => socket.send(JSON.stringify({ type: 'error', error: { message: 'private error' } })),
    socket => socket.send(JSON.stringify({ type: 'session.closed', session: { id: 'another' }, usage: { seconds: 15 } })),
    socket => socket.send(JSON.stringify({ type: 'session.closed', usage: { seconds: -1 } })),
    socket => socket.send('malformed'),
  ];
  for (const command of commands) {
    fake.setCommandHandler(command);
    assert.deepEqual(await fake.provider.close('session_test'), { confirmed: false });
  }
});

test('helper deadline aborts a pending upstream call without replay', async t => {
  const fake = await fakeAzure(t);
  let notifyStarted;
  const started = new Promise(resolve => { notifyStarted = resolve; });
  fake.setHandler(async () => { notifyStarted(); });
  const pending = fake.provider.respond(helper(), AbortSignal.timeout(1000));
  const rejected = assert.rejects(pending, /provider_request_aborted/);
  await started;
  await rejected;
  assert.equal(fake.calls.length, 1);
});

test('gateway shutdown aborts helpers before draining and closes its listening socket', async t => {
  const fake = await fakeAzure(t);
  let notifyStarted;
  const started = new Promise(resolve => { notifyStarted = resolve; });
  fake.setHandler(async () => { notifyStarted(); });
  const app = createApp(config, { provider: fake.provider, log() {} });
  await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => app.close());
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const pending = fetch(`${origin}/v1/responses`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(helper()),
  });
  await started;
  await app.close();
  const response = await pending;
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, 'provider_request_aborted');
  assert.equal(app.server.listening, false);
  assert.equal(fake.calls.length, 1);
});

test('real HTTP gateway exposes health and aborts upstream helpers after client disconnect', async t => {
  const fake = await fakeAzure(t);
  let notifyStarted, notifyAborted;
  const started = new Promise(resolve => { notifyStarted = resolve; });
  const aborted = new Promise(resolve => { notifyAborted = resolve; });
  fake.setHandler(async (_request, response) => {
    response.once('close', notifyAborted);
    notifyStarted();
  });
  const app = createApp(config, { provider: fake.provider, log() {} });
  await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => app.close());
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await fetch(`${origin}/healthz`)).status, 200);
  const controller = new AbortController();
  const request = fetch(`${origin}/v1/responses`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(helper()), signal: controller.signal,
  });
  const rejected = assert.rejects(request, { name: 'AbortError' });
  await started;
  controller.abort();
  await rejected;
  await Promise.race([aborted, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('Upstream was not aborted.')), 2000);
    timer.unref();
  })]);
});

test('cancelled SDP request closes a late successful provider session rather than replaying create', async t => {
  const fake = await fakeAzure(t);
  let release, notifyStarted, notifyClosed;
  const held = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { notifyStarted = resolve; });
  const closed = new Promise(resolve => { notifyClosed = resolve; });
  fake.setHandler(async (_request, response) => {
    notifyStarted();
    await held;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ session: { id: 'session_test' }, transport: { type: 'webrtc', sdp: 'v=0\r\nanswer' } }));
  });
  fake.setCommandHandler(socket => {
    socket.send(JSON.stringify({ type: 'session.closed', session: { id: 'session_test' }, usage: { seconds: 15 } }));
    notifyClosed();
  });
  const app = createApp(config, { provider: fake.provider, log() {} });
  await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => app.close());
  const controller = new AbortController();
  const request = fetch(`http://127.0.0.1:${app.server.address().port}/v1/live/sessions`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(voice()), signal: controller.signal,
  });
  const rejected = assert.rejects(request, { name: 'AbortError' });
  await started;
  controller.abort();
  await rejected;
  await new Promise(resolve => setTimeout(resolve, 25));
  release();
  await Promise.race([closed, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('Late session was not closed.')), 2000);
    timer.unref();
  })]);
  assert.equal(fake.calls.length, 1);
});
