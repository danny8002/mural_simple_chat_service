import { ServiceError } from './errors.js';

const languages = new Set([
  'nb-NO', 'es-ES', 'en', 'en-US', 'fr-FR', 'de-DE', 'it-IT', 'pt-BR',
  'zh-CN', 'sr-Latn-RS', 'el-GR', 'tl-PH', 'nl-NL', 'ru-RU',
]);
const purposes = new Set(['meaning', 'assessment', 'lookup', 'delegation', 'typed_reply', 'topic', 'help']);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const invalid = () => { throw new ServiceError('invalid_request'); };
export const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const validSessionID = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value);
const text = (value, limit) => typeof value === 'string' && value.trim().length > 0 &&
  Buffer.byteLength(value) <= limit && !/[\uD800-\uDFFF\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value);

function fields(value, allowed) {
  if (!isObject(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid();
}

function requestID(value) {
  if (typeof value !== 'string' || !uuid.test(value)) invalid();
  return value.toLowerCase();
}

export function voiceInput(body) {
  fields(body, ['requestID', 'sdp', 'language', 'instructions', 'history']);
  const id = requestID(body.requestID);
  if (!text(body.sdp, 65_536) || !body.sdp.startsWith('v=0') ||
      !languages.has(body.language) || !text(body.instructions, 12_000)) invalid();
  const history = body.history ?? [];
  if (!Array.isArray(history) || history.length > 40 || Buffer.byteLength(JSON.stringify(history)) > 6_000) invalid();
  for (const message of history) {
    fields(message, ['type', 'role', 'content']);
    if (message.type !== 'message' || !['user', 'assistant'].includes(message.role) ||
        !Array.isArray(message.content) || message.content.length !== 1) invalid();
    const part = message.content[0];
    fields(part, ['type', 'text']);
    if (part.type !== (message.role === 'user' ? 'input_text' : 'output_text') || !text(part.text, 6_000)) invalid();
  }
  return { ...body, requestID: id, history };
}

function schema(value, depth = 0, count = { nodes: 0 }) {
  fields(value, ['type', 'properties', 'required', 'additionalProperties', 'items', 'enum',
    'minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength', 'description']);
  if (++count.nodes > 400 || depth > 8 ||
      !['object', 'array', 'string', 'integer', 'number', 'boolean', 'null'].includes(value.type)) invalid();
  if (value.description !== undefined && !text(value.description, 1000)) invalid();
  if (value.type === 'object') {
    if (!isObject(value.properties) || value.additionalProperties !== false ||
        Object.keys(value.properties).length > 60 || !Array.isArray(value.required) ||
        value.required.length !== Object.keys(value.properties).length ||
        new Set(value.required).size !== value.required.length ||
        value.required.some(key => typeof key !== 'string' || !Object.hasOwn(value.properties, key))) invalid();
    for (const [key, child] of Object.entries(value.properties)) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) invalid();
      schema(child, depth + 1, count);
    }
  } else if (['properties', 'required', 'additionalProperties'].some(key => value[key] !== undefined)) invalid();
  if (value.type === 'array') schema(value.items, depth + 1, count);
  else if (value.items !== undefined) invalid();
  if (value.enum !== undefined && (!Array.isArray(value.enum) || !value.enum.length || value.enum.length > 80 ||
      value.enum.some(item => !['string', 'boolean', 'number'].includes(typeof item) ||
        (typeof item === 'string' && !text(item, 300)) || (typeof item === 'number' && !Number.isFinite(item))))) invalid();
  for (const key of ['minimum', 'maximum']) {
    if (value[key] !== undefined && (!Number.isFinite(value[key]) || Math.abs(value[key]) > 1_000_000)) invalid();
  }
  for (const key of ['minItems', 'maxItems', 'minLength', 'maxLength']) {
    if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 10_000)) invalid();
  }
  for (const [min, max] of [['minimum', 'maximum'], ['minItems', 'maxItems'], ['minLength', 'maxLength']]) {
    if (value[min] !== undefined && value[max] !== undefined && value[min] > value[max]) invalid();
  }
}

export function helperInput(body, searchEnabled) {
  fields(body, ['requestID', 'purpose', 'instructions', 'input', 'schema', 'search', 'stream']);
  const id = requestID(body.requestID);
  if (!purposes.has(body.purpose) || !text(body.instructions, 16_384) || !text(body.input, 24_576) ||
      (body.search !== undefined && typeof body.search !== 'boolean') ||
      (body.stream !== undefined && typeof body.stream !== 'boolean')) invalid();
  if (body.search && !['topic', 'delegation'].includes(body.purpose)) invalid();
  if (body.search && !searchEnabled) throw new ServiceError('search_unavailable', 422);
  if (body.schema !== undefined) {
    if (body.purpose !== 'assessment' || Buffer.byteLength(JSON.stringify(body.schema)) > 12_288) invalid();
    schema(body.schema);
    if (body.schema.type !== 'object') invalid();
  } else if (body.purpose === 'assessment') invalid();
  return { ...body, requestID: id };
}

export function closeInput(body) {
  fields(body, ['closeHandle']);
  if (!text(body.closeHandle, 2048)) invalid();
  return body.closeHandle;
}
