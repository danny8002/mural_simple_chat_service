import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { ServiceError } from './errors.js';
import { validSessionID } from './validation.js';

const digest = value => createHash('sha256').update(value).digest();
export function authorized(header, key) {
  return typeof header === 'string' && header.startsWith('Bearer ') &&
    timingSafeEqual(digest(header.slice(7)), digest(key));
}

export class CloseHandles {
  constructor(config, now = Date.now) {
    this.key = config.signingSecret;
    this.audience = digest(`${config.liveOrigin}/${config.liveDeployment}`).toString('base64url');
    this.now = now;
  }
  signature(payload) {
    return createHmac('sha256', this.key).update(`mural-close:v1:${payload}`).digest();
  }
  issue(id) {
    if (!validSessionID(id)) throw new ServiceError('provider_create_uncertain', 502);
    const iat = Math.floor(this.now() / 1000);
    const payload = Buffer.from(JSON.stringify({ v: 1, id, iat, exp: iat + 7200, aud: this.audience })).toString('base64url');
    return `${payload}.${this.signature(payload).toString('base64url')}`;
  }
  verify(handle) {
    const invalid = () => { throw new ServiceError('invalid_close_handle'); };
    if (typeof handle !== 'string' || handle.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(handle)) invalid();
    const [payload, signature] = handle.split('.');
    const received = Buffer.from(signature, 'base64url'), expected = this.signature(payload);
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) invalid();
    let data;
    try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { invalid(); }
    const now = Math.floor(this.now() / 1000);
    if (!data || data.v !== 1 || data.aud !== this.audience || !validSessionID(data.id) ||
        !Number.isSafeInteger(data.iat) || data.iat > now + 60 || data.exp !== data.iat + 7200 || data.exp <= now) invalid();
    return data.id;
  }
}

export class Admission {
  constructor(now = Date.now) {
    this.now = now;
    this.requests = new Map();
    this.active = { voice: 0, helper: 0, close: 0 };
    this.buckets = new Map();
  }
  enter(kind, requestID) {
    const now = this.now();
    for (const [id, expires] of this.requests) if (expires <= now) this.requests.delete(id);
    const limit = { voice: 1, helper: 2, close: 2 }[kind];
    if (this.active[kind] >= limit) throw new ServiceError('concurrency_limit', 429);
    const bucket = this.buckets.get(kind);
    const maximum = { voice: 6, helper: 24, close: 30 }[kind];
    if (bucket && now < bucket.until && bucket.count >= maximum) throw new ServiceError('rate_limit', 429);
    if (requestID && this.requests.has(requestID)) throw new ServiceError('duplicate_request', 409);
    if (requestID && this.requests.size >= 2048) throw new ServiceError('request_cache_full', 503);
    if (!bucket || now >= bucket.until) this.buckets.set(kind, { count: 1, until: now + 60_000 });
    else bucket.count++;
    if (requestID) this.requests.set(requestID, now + 3_600_000);
    this.active[kind]++;
    return () => { this.active[kind]--; };
  }
}
