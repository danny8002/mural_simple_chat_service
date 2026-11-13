import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { helperInput, voiceInput } from '../src/validation.js';
import { Admission, authorized, CloseHandles } from '../src/state.js';
import { assessmentSchema, config, environment, helper, voice } from './support.js';

test('configuration requires secrets, deployments and safe Azure origins without a database', () => {
  assert.equal(loadConfig(environment).port, 10000);
  for (const name of Object.keys(environment)) {
    const env = { ...environment };
    delete env[name];
    assert.throws(() => loadConfig(env), new RegExp(name));
  }
  for (const value of [
    'http://voice-test.openai.azure.com', 'https://evil.example.com',
    'https://voice-test.openai.azure.com.evil.example.com',
    'https://user:password@voice-test.openai.azure.com',
    'https://voice-test.openai.azure.com:8443', 'https://voice-test.openai.azure.com/openai/v1',
    'https://voice-test.openai.azure.com?secret=hidden', 'https://voice-test.openai.azure.com#fragment',
  ]) {
    assert.throws(() => loadConfig({ ...environment, AZURE_LIVE_ENDPOINT: value }), /AZURE_LIVE_ENDPOINT/);
  }
  for (const value of ['0', '65536', 'abc', '1.5', '']) {
    assert.throws(() => loadConfig({ ...environment, PORT: value }), /PORT/);
  }
  assert.throws(() => loadConfig({ ...environment, ENABLE_WEB_SEARCH: 'yes' }));
  assert.throws(() => loadConfig({ ...environment, APIKEY: 'short' }));
  assert.equal(authorized(`Bearer ${config.apiKey}`, config.apiKey), true);
  for (const header of [undefined, '', config.apiKey, 'Bearer wrong', `Basic ${config.apiKey}`]) {
    assert.equal(authorized(header, config.apiKey), false);
  }
});

test('voice validation preserves bounded history but rejects caller-selected resources and malformed content', () => {
  assert.deepEqual(voiceInput(voice()).history[0].content[0], { type: 'input_text', text: 'Hola' });
  const invalid = [
    null, { ...voice(), model: 'other' }, { ...voice(), language: 'unsupported' },
    { ...voice(), sdp: 'invalid' }, { ...voice(), sdp: `v=0${'x'.repeat(65_536)}` },
    { ...voice(), instructions: '\ud800' }, { ...voice(), history: Array(41).fill({}) },
    { ...voice(), history: [{ type: 'message', role: 'system', content: [] }] },
    { ...voice(), history: [{ type: 'message', role: 'user', content: [{ type: 'output_text', text: 'x' }] }] },
  ];
  for (const input of invalid) assert.throws(() => voiceInput(input), /invalid_request/);
});

test('helper schema validation, tools, search and output-purpose restrictions', () => {
  const valid = { ...helper(), purpose: 'assessment', schema: assessmentSchema };
  assert.deepEqual(helperInput(valid, false).schema, assessmentSchema);
  for (const input of [
    { ...helper(), schema: assessmentSchema },
    { ...helper(), purpose: 'assessment' },
    { ...valid, schema: { ...assessmentSchema, $ref: 'https://example.com/schema' } },
    { ...valid, schema: { ...assessmentSchema, required: [] } },
    { ...valid, schema: { ...assessmentSchema, properties: { level: { type: 'integer', minimum: 5, maximum: 1 } } } },
    { ...helper(), model: 'other' }, { ...helper(), tools: [] }, { ...helper(), stream: 'true' },
    { ...helper(), search: true }, { ...helper(), input: 'x'.repeat(24_577) },
  ]) assert.throws(() => helperInput(input, false), /invalid_request/);
  assert.throws(() => helperInput({ ...helper(), purpose: 'topic', search: true }, false), /search_unavailable/);
  assert.equal(helperInput({ ...helper(), purpose: 'topic', search: true }, true).search, true);
  let deep = { type: 'string' };
  for (let i = 0; i < 10; i++) deep = { type: 'array', items: deep };
  assert.throws(() => helperInput({ ...valid, schema: {
    type: 'object', properties: { nested: deep }, required: ['nested'], additionalProperties: false,
  } }, false));
});

test('signed handles survive restart but reject tampering, expiry and resource changes', () => {
  let time = 1_000_000;
  const signer = new CloseHandles(config, () => time);
  const handle = signer.issue('session_test');
  assert.equal(new CloseHandles(config, () => time).verify(handle), 'session_test');
  assert.throws(() => signer.verify(`x${handle}`), /invalid_close_handle/);
  assert.throws(() => signer.verify(`${handle}.extra`), /invalid_close_handle/);
  assert.throws(() => new CloseHandles({ ...config, liveDeployment: 'other' }, () => time).verify(handle));
  assert.throws(() => new CloseHandles({ ...config, signingSecret: 'other' }, () => time).verify(handle));
  assert.throws(() => signer.issue('../session'));
  time += 7_200_000;
  assert.throws(() => signer.verify(handle), /invalid_close_handle/);
});

test('transient admission bounds concurrency, replay, rate and cache size', () => {
  let time = 1_000_000;
  const state = new Admission(() => time);
  const release = state.enter('voice', 'one');
  assert.throws(() => state.enter('voice', 'two'), /concurrency_limit/);
  release();
  assert.throws(() => state.enter('voice', 'one'), /duplicate_request/);
  for (let i = 0; i < 5; i++) state.enter('voice', `other-${i}`)();
  assert.throws(() => state.enter('voice', 'seven'), /rate_limit/);
  time += 60_000;
  state.enter('voice', 'seven')();
  time += 3_600_000;
  state.enter('voice', 'one')();
  assert.equal(state.requests.size, 1);
  const full = new Admission(() => time);
  for (let i = 0; i < 2048; i++) full.requests.set(`id-${i}`, time + 1);
  assert.throws(() => full.enter('helper', 'extra'), /request_cache_full/);
  assert.equal(full.active.helper, 0);
});
