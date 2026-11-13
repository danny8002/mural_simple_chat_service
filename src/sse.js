import { ServiceError } from './errors.js';
import { isObject } from './validation.js';

export function completedResponse(value) {
  if (!isObject(value) || value.status !== 'completed' || !Array.isArray(value.output)) {
    throw new ServiceError('provider_response_incomplete', 502);
  }
  return value;
}

export async function* responseEvents(body) {
  const reader = body?.getReader();
  if (!reader) throw new ServiceError('provider_response_invalid', 502);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '', total = 0, eventBytes = 0, lines = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 2_097_152) throw new ServiceError('provider_response_too_large', 502);
      pending += decoder.decode(value, { stream: true });
      let end;
      while ((end = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, end).replace(/\r$/, '');
        pending = pending.slice(end + 1);
        eventBytes += Buffer.byteLength(line) + 1;
        if (eventBytes > 65_536) throw new ServiceError('provider_response_too_large', 502);
        if (line) {
          if (line.startsWith('data:')) lines.push(line.slice(5).replace(/^ /, ''));
          continue;
        }
        const payload = lines.join('\n');
        lines = []; eventBytes = 0;
        if (!payload) continue;
        let event;
        try { event = JSON.parse(payload); } catch { throw new ServiceError('provider_response_invalid', 502); }
        if (!isObject(event) || typeof event.type !== 'string') throw new ServiceError('provider_response_invalid', 502);
        if (['error', 'response.failed', 'response.incomplete', 'response.cancelled'].includes(event.type)) {
          throw new ServiceError('provider_response_incomplete', 502);
        }
        if (event.type === 'response.completed') {
          completedResponse(event.response);
          yield event;
          return;
        }
        if (event.type === 'response.output_text.delta' && typeof event.delta !== 'string') {
          throw new ServiceError('provider_response_invalid', 502);
        }
        if (!event.type.startsWith('response.')) throw new ServiceError('provider_response_invalid', 502);
        yield event;
      }
      if (Buffer.byteLength(pending) + eventBytes > 65_536) throw new ServiceError('provider_response_too_large', 502);
    }
    throw new ServiceError('provider_response_incomplete', 502);
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
