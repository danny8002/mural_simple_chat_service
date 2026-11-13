import assert from 'node:assert/strict';
import { test } from 'node:test';
import { responseEvents } from '../src/sse.js';
import { completed, delta, frame } from './support.js';

async function decode(text, split = 7) {
  const bytes = Buffer.from(text);
  const stream = new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += split) controller.enqueue(bytes.subarray(offset, offset + split));
      controller.close();
    },
  });
  return Array.fromAsync(responseEvents(stream));
}

test('SSE handles split UTF-8/CRLF, comments and terminal completion', async () => {
  const unicode = { ...delta, delta: '你好 👋' };
  assert.deepEqual(await decode(`: heartbeat\r\n\r\n${frame(unicode)}${frame(completed)}`.replaceAll('\n', '\r\n').replaceAll('\r\r', '\r'), 1),
    [unicode, completed]);
  const refusal = { type: 'response.refusal.delta', delta: 'Cannot help' };
  assert.deepEqual(await decode(frame(refusal) + frame(completed)), [refusal, completed]);
});

test('SSE never turns truncated, failed, malformed or oversized streams into success', async () => {
  for (const text of [
    frame(delta), 'data: [DONE]\n\n', 'data: {bad}\n\n',
    frame({ type: 'error', error: { message: 'private upstream error' } }),
    frame({ type: 'response.incomplete' }),
    frame({ type: 'response.completed', response: { status: 'incomplete', output: [] } }),
    frame({ type: 'response.output_text.delta', delta: 42 }),
    frame({ type: 'unexpected' }),
    `data: ${'x'.repeat(65_536)}\n\n`,
  ]) await assert.rejects(decode(text));
  await assert.rejects(decode(': comment\n\n'.repeat(210_000), 4096), /too_large/);
});
