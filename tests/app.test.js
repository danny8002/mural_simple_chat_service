import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { config, auth, completed, delta, helper, result, voice } from './support.js';

function fixture(t, changes = {}) {
  const calls = [], logs = [];
  const provider = {
    async create(input) { calls.push(['create', input]); return { session: { id: 'session_test' }, transport: { type: 'webrtc', sdp: 'v=0\r\nanswer' } }; },
    async respond(input) { calls.push(['helper', input]); return result; },
    async *stream(input) { calls.push(['stream', input]); yield delta; yield completed; },
    async close(id) { calls.push(['close', id]); return { confirmed: true }; },
    ...changes,
  };
  const app = createApp(config, { provider, log: record => logs.push(record) });
  t.after(() => app.close());
  const post = (url, payload, headers = auth) => app.inject({ method: 'POST', url, payload, headers });
  return { app, provider, calls, logs, post };
}

test('health is public/non-billable; all private routes authenticate before parsing or provider access', async t => {
  const { app, post, calls, logs } = fixture(t);
  assert.deepEqual((await app.inject('/healthz')).json(), { status: 'ok', protocolVersion: 1 });
  for (const url of ['/v1/live/sessions', '/v1/responses', '/v1/live/close']) {
    for (const headers of [{}, { authorization: 'Bearer invalid' }]) {
      const response = await post(url, {}, headers);
      assert.equal(response.statusCode, 401);
      assert.equal(response.json().error.code, 'unauthorized');
      assert.equal(response.headers['cache-control'], 'no-store');
    }
  }
  assert.equal((await app.inject({ url: '/v1/capabilities', headers: auth })).json().webSearch, false);
  assert.equal((await app.inject({ url: '/missing?secret=do-not-log', headers: auth })).statusCode, 404);
  assert.equal(calls.length, 0);
  assert.doesNotMatch(JSON.stringify(logs), /do-not-log|private-test-key/);
});

test('voice session returns a restart-safe close handle, deduplicates creates and closes only signed IDs', async t => {
  const { post, calls } = fixture(t);
  const input = voice();
  const response = await post('/v1/live/sessions', input);
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().transport.sdp, 'v=0\r\nanswer');
  assert.equal((await post('/v1/live/sessions', input)).statusCode, 409);
  assert.equal(calls.filter(([kind]) => kind === 'create').length, 1);
  assert.equal((await post('/v1/live/close', { closeHandle: `${response.json().closeHandle}bad` })).statusCode, 400);
  const restart = fixture(t);
  assert.deepEqual((await restart.post('/v1/live/close', { closeHandle: response.json().closeHandle })).json(), { status: 'confirmed' });
  assert.deepEqual(restart.calls, [['close', 'session_test']]);
});

test('unconfirmed provider close is explicit, never success-shaped confirmation', async t => {
  const { post, logs } = fixture(t, { async close() { return { confirmed: false }; } });
  const created = (await post('/v1/live/sessions', voice())).json();
  assert.deepEqual((await post('/v1/live/close', { closeHandle: created.closeHandle })).json(), { status: 'unconfirmed' });
  assert.ok(logs.some(record => record.event === 'voice_close_unconfirmed'));
});

test('helper JSON and SSE retain Responses output, citations and terminal state without a voice lease', async t => {
  const { post, calls } = fixture(t);
  assert.deepEqual((await post('/v1/responses', helper())).json(), result);
  const streamed = await post('/v1/responses', { ...helper(), stream: true });
  assert.equal(streamed.statusCode, 200);
  assert.match(streamed.headers['content-type'], /text\/event-stream/);
  assert.match(streamed.body, /response.output_text.delta/);
  assert.match(streamed.body, /response.completed/);
  assert.equal(calls.length, 2);
});

test('invalid input, disabled search and oversized bodies never call the provider', async t => {
  const { post, calls } = fixture(t);
  assert.equal((await post('/v1/responses', { ...helper(), model: 'other' })).statusCode, 400);
  assert.equal((await post('/v1/responses', { ...helper(), purpose: 'topic', search: true })).statusCode, 422);
  assert.equal((await post('/v1/responses', { ...helper(), input: 'x'.repeat(70_000) })).statusCode, 413);
  const malformed = await post('/v1/responses', '{not json', { ...auth, 'content-type': 'application/json' });
  assert.equal(malformed.statusCode, 400);
  assert.equal(calls.length, 0);
});

test('provider failures are sanitized, not retried, and streaming failures remain terminal errors', async t => {
  const { post, logs } = fixture(t, {
    async create() { throw new Error('do-not-log-provider-secret'); },
    async *stream() { yield delta; throw new Error('do-not-log-helper-content'); },
  });
  const input = voice();
  const failed = await post('/v1/live/sessions', input);
  assert.equal(failed.statusCode, 500);
  assert.equal(failed.json().error.retryable, false);
  assert.equal((await post('/v1/live/sessions', input)).statusCode, 409);
  const streamed = await post('/v1/responses', { ...helper(), stream: true });
  assert.match(streamed.body, /"type":"error"/);
  assert.doesNotMatch(streamed.body, /response.completed|do-not-log/);
  assert.doesNotMatch(JSON.stringify(logs), /do-not-log/);
});

test('two helper slots are bounded and released after completion', async t => {
  const pending = [], started = [];
  const { app, post } = fixture(t, {
    async respond(input, signal) {
      started.push(signal);
      await new Promise(resolve => pending.push(resolve));
      return result;
    },
  });
  await app.ready();
  const first = post('/v1/responses', helper());
  const second = post('/v1/responses', helper());
  const firstPromise = first.then(value => value), secondPromise = second.then(value => value);
  while (pending.length < 2) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await post('/v1/responses', helper())).statusCode, 429);
  pending.splice(0).forEach(resolve => resolve());
  assert.equal((await firstPromise).statusCode, 200);
  assert.equal((await secondPromise).statusCode, 200);
  assert.equal(started.every(signal => signal.aborted), true);
});
