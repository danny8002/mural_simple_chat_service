import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';

export const environment = {
  APIKEY: 'private-test-key-not-a-secret-000000000',
  SESSION_SIGNING_SECRET: 'signing-test-key-not-a-secret-000000000',
  AZURE_LIVE_ENDPOINT: 'https://voice-test.openai.azure.com',
  AZURE_LIVE_API_KEY: 'voice-test-key-not-a-secret',
  AZURE_LIVE_DEPLOYMENT: 'private-voice-deployment',
  AZURE_RESPONSES_ENDPOINT: 'https://text-test.openai.azure.com',
  AZURE_RESPONSES_API_KEY: 'text-test-key-not-a-secret',
  AZURE_RESPONSES_DEPLOYMENT: 'private-text-deployment',
};
export const config = loadConfig(environment);
export const auth = { authorization: `Bearer ${config.apiKey}` };
export const voice = () => ({
  requestID: randomUUID(), sdp: 'v=0\r\nfake-offer', language: 'es-ES',
  instructions: 'Speak Spanish and ask one question.',
  history: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hola' }] }],
});
export const helper = () => ({
  requestID: randomUUID(), purpose: 'meaning', instructions: 'Explain this passage.', input: 'Hola',
});
export const assessmentSchema = {
  type: 'object', additionalProperties: false, required: ['level'],
  properties: { level: { type: 'integer', minimum: 0, maximum: 5 } },
};
export const result = {
  id: 'resp_test', status: 'completed',
  output: [{ type: 'message', content: [{
    type: 'output_text', text: 'Hello',
    annotations: [{ type: 'url_citation', title: 'Source', url: 'https://example.com' }],
  }] }],
  usage: { input_tokens: 10, output_tokens: 2 },
};
export const completed = { type: 'response.completed', response: result };
export const delta = { type: 'response.output_text.delta', delta: 'Hello' };
export const frame = event => `data: ${JSON.stringify(event)}\n\n`;
