# Mural Simple Chat Service

A private **Node.js** gateway for Mural's core talking features, using Azure
OpenAI **gpt-live-1** for voice and **gpt-5.6-luna** for teaching helpers.

**No SQL, database, accounts, sign-in, payments, wallet, or persistent storage.**
The service negotiates voice sessions; audio and session events travel directly
between the client and Azure over WebRTC. Helpers pass through this server.

This repository implements the server only. The existing Mural iOS app needs a
separate private-endpoint integration; this is not a drop-in replacement for
Mural's account-funded hosted API.

## Run locally

Requires Node.js 22.20 or later in the Node 22 LTS line.

```powershell
npm ci
Copy-Item .env.example .env
```

Edit the ignored `.env` file:

| Variable | Required value |
| --- | --- |
| `APIKEY` | Your private server's shared key, at least 32 non-whitespace ASCII characters. |
| `SESSION_SIGNING_SECRET` | A different random secret of at least 32 characters. Keep stable across restarts. |
| `AZURE_LIVE_ENDPOINT` | Voice resource origin, e.g. `https://your-resource.openai.azure.com`. No path or query. |
| `AZURE_LIVE_API_KEY` | Azure voice resource API key, server-only. |
| `AZURE_LIVE_DEPLOYMENT` | Your deployment name for `gpt-live-1`. |
| `AZURE_RESPONSES_ENDPOINT` | Text resource origin; may be the same as the voice origin. |
| `AZURE_RESPONSES_API_KEY` | Azure text resource API key, server-only. |
| `AZURE_RESPONSES_DEPLOYMENT` | Your deployment name for `gpt-5.6-luna`. |
| `ENABLE_WEB_SEARCH` | Optional, `false` by default. See search below. |
| `PORT` | Optional locally, defaults to `10000`; supplied by Render. |

Generate each private/signing secret independently, for example:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Do not use an Azure resource key as `APIKEY`, commit secrets, or put them in
request URLs. API startup validates configuration without calling Azure.

```powershell
npm start
```

The server binds `0.0.0.0:$PORT`. For auto-reload during development, use
`npm run dev`. Local HTTP is for development; clients must use HTTPS on Render.

## Deploy to Render Free

1. Push this repository to your Git provider when ready.
2. Create a Render Blueprint from `render.yaml`, or create one Docker web service:
   **Free**, Dockerfile path **`./Dockerfile`**, build context **`.`**, health
   check **`/healthz`**. Leave the Docker command override empty to use the image's
   startup command.
3. Configure the Azure environment variables above. Use actual deployment names,
   not an assumed model alias. Confirm region, access and quotas.
4. The Blueprint generates `APIKEY` and `SESSION_SIGNING_SECRET`. Retrieve
   `APIKEY` privately from the dashboard for the later client configuration.
   Preserve these values during redeploys, especially the signing secret.
5. Check the deploy logs for `service_started` and the deployed Git revision.
   Verify `/healthz`, rejection of a wrong key and authenticated capabilities.
   These probes do not invoke Azure or incur model charges.

Do not create a Render database, disk, Redis service or background worker.
Render supplies HTTPS; no separate reverse proxy is required.

### Docker and the 500 MB memory budget

The multi-stage `Dockerfile` uses Node 22 on Debian slim and copies only production
dependencies and application code into the runtime image. `.dockerignore` excludes
local dependencies, tests, Git history and `.env` secrets from the build context.
The process runs as the non-root `node` user, directly (without an npm parent),
and receives Render's shutdown signals.

`NODE_OPTIONS=--max-old-space-size=256` caps V8's old-generation heap at 256 MiB,
leaving headroom within a 500 MB instance for other heap regions, native memory,
network buffers and shared libraries. This is **not** a total-process memory
limit or a guarantee against out-of-memory termination; monitor Render memory
metrics under your expected traffic. Existing helper concurrency and buffering
limits remain in place. The model runs on Azure, not inside this container.

To build and run locally after configuring `.env`:

```powershell
docker build -t mural-simple-chat-service .
docker run --rm --memory=500m --env-file .env -e PORT=10000 -p 10000:10000 mural-simple-chat-service
```

The local `--memory` option limits the container; Render enforces the hosting
instance's own limit. Do not put credentials in the image or build arguments;
configure them as Render environment secrets.

The owner manages an **external timer** requesting public `GET /healthz`, for
example every 10 minutes. No client wake-up logic or server self-ping is provided.
Render Free can still restart/suspend and has shared instance-hour, bandwidth
and build limits. Continuous operation uses up to 744 hours in a 31-day month
against the workspace's 750 free hours. Check current Render terms and limits.
Azure inference and tools are billed separately; free hosting is not free AI.

## API

All responses disable caching. Every `/v1/*` endpoint requires:

```http
Authorization: Bearer <your APIKEY>
Content-Type: application/json
```

The gateway compares the bearer key securely with its environment `APIKEY`
before contacting Azure. Wrong/missing keys return `401 unauthorized`. Azure
credentials never go to the client, and the incoming `APIKEY` never goes to Azure.

### Health and capabilities (no paid calls)

`GET /healthz` is public and returns:

```json
{ "status": "ok", "protocolVersion": 1 }
```

`GET /v1/capabilities` requires `APIKEY` and returns configuration-based support:

```json
{ "protocolVersion": 1, "voice": true, "helpers": true, "webSearch": false }
```

Capabilities do not prove that the configured Azure deployments are accessible.

### Create a voice session

`POST /v1/live/sessions`

```json
{
  "requestID": "b7d6d842-7707-4af0-a351-17da76746028",
  "sdp": "v=0\r\n...client-generated SDP offer...",
  "language": "es-ES",
  "instructions": "Speak Spanish. Be a warm language conversation partner.",
  "history": []
}
```

Supply a fresh UUID v4 for each deliberate new attempt. `history` is optional,
with at most 40 messages and 6,000 serialized UTF-8 bytes:

```json
[
  { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "Hola" }] },
  { "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "Hola." }] }
]
```

Supported language IDs: `nb-NO`, `es-ES`, `en`, `en-US`, `fr-FR`, `de-DE`,
`it-IT`, `pt-BR`, `zh-CN`, `sr-Latn-RS`, `el-GR`, `tl-PH`, `nl-NL`, `ru-RU`.
Send teaching instructions for the chosen language; the gateway preserves them
and appends the learning locale and a history-data boundary.

Response:

```json
{
  "session": { "id": "sess_example" },
  "transport": { "type": "webrtc", "sdp": "v=0\r\n...Azure SDP answer..." },
  "closeHandle": "<signed handle>"
}
```

Apply the answer to the client's WebRTC peer. Wait for `session.started` on
the `oai-events` data channel, not merely this HTTP response. Voice is `marin`
and delegation is `client`. The client handles transcript fragments, context
append commands, mute/unmute and delegated helper requests using GPT-Live's
`session.*` protocol. **Do not use GPT Realtime's ephemeral-key flow.**

Azure voice creation has a 10-second timeout. Calls are never automatically
retried. A failed/uncertain create might still have incurred charges.

### Text and teaching helpers

`POST /v1/responses`

```json
{
  "requestID": "a1ef3421-4aba-4f4f-8b5a-a1588b506b0b",
  "purpose": "meaning",
  "instructions": "Explain the Spanish passage in English.",
  "input": "Buenos dias.",
  "stream": false
}
```

Purposes: `meaning`, `assessment`, `lookup`, `delegation`, `typed_reply`, `topic`,
`help`. No active voice session is required, so final assessments can run after
a call ends.

The deployment is selected by the server, not a caller's `model`. The gateway
sets low reasoning effort, `store: false`, `background: false` and output caps
of 1,400 tokens, or 2,200 for assessments. JSON responses preserve the Azure
Responses result, including `output`, citations, refusal content and `usage`.
A result must have `status: "completed"`; incomplete results are errors.

For assessment, set `purpose: "assessment"` and include `schema`:

```json
{
  "type": "object",
  "properties": { "level": { "type": "integer", "minimum": 0, "maximum": 5 } },
  "required": ["level"],
  "additionalProperties": false
}
```

The supported strict JSON-schema subset includes nested objects, arrays,
enums, primitive types, descriptions and basic length/numeric constraints.
All object properties must be required with `additionalProperties: false`.
Remote references, arbitrary tools and caller-controlled upstream URLs are rejected.

Set `"stream": true` for `text/event-stream`. The server forwards Responses
events such as `response.output_text.delta` and `response.completed`. Refusal
events remain refusals. A stream failure emits a sanitized `error` event after
headers have started; a partial result is never marked completed.

Helpers have a 45-second overall timeout, bounded buffering and backpressure.
Disconnecting aborts the upstream request where possible, but does not prove
Azure stopped work or billing.

**Search:** disabled by default. A request with `"search": true` returns
`422 search_unavailable`. Only enable `ENABLE_WEB_SEARCH=true` after verifying
Azure `web_search` support and extra costs. Search is then restricted to `topic`
and `delegation`, with at most one tool call per request. Never silently label
unsourced model output as research.

### Close a session

Send `session.close` over the client's data channel and wait for `session.closed`.
For cancellation/failure recovery, use `POST /v1/live/close`:

```json
{ "closeHandle": "<handle returned by create>" }
```

The gateway briefly attaches an authenticated Azure sideband, requests close
and waits up to eight seconds for a valid terminal event.

```json
{ "status": "confirmed" }
```

If closure cannot be verified, the result is explicitly:

```json
{ "status": "unconfirmed" }
```

A disconnected socket or successful command send is not confirmation.
Repeated closes may be unconfirmed if Azure no longer permits attaching to the
ended session. No HTTP hangup support is assumed.

Close handles last **two hours** and remain verifiable after a gateway restart
with the same signing secret and voice resource/deployment. End sessions before
expiry. The handle is not an Azure credential; it is signed, not encrypted.
It still requires `APIKEY`. Protect it and do not log it.

### Errors and transient limits

```json
{
  "error": {
    "code": "unauthorized",
    "reference": "<opaque request reference>",
    "retryable": false
  }
}
```

HTTP errors include `X-Request-Reference`. Match the reference to JSON logs.
Provider errors are sanitized; raw error bodies are never returned or logged.

- Global authenticated limit: 120 requests/minute.
- Voice creates: one in flight, six/minute.
- Helpers: two in flight, 24/minute.
- Close requests: two in flight, 30/minute.
- Helper bodies: 64 KiB; voice bodies: 96 KiB.
- SDP: 64 KiB; voice instructions: 12,000 bytes.
- Helper instructions/input: 16/24 KiB; schema: 12 KiB, depth 8, 400 nodes.
- Upstream helper JSON: 1 MiB; SSE: 2 MiB total, 64 KiB/event.
- Request IDs: at most 2,048 retained for one hour per process.

Duplicates return `409 duplicate_request`; limit failures return `429`.
A full request cache returns `503` rather than evicting active protections.
All counters reset on restart. There is **no durable idempotency, billing
reconciliation, daily spending cap, or active-call quota**.

Do not automatically retry creates or helpers on ambiguous failures. If a
create succeeds after a known client disconnect, the gateway attempts closure.
If the create response is lost upstream, its unknown session cannot be recovered.

## Data, operations and verification

The service persists no conversation content or usage records. Request content
is transiently processed in memory. JSON logs contain fixed operations, status,
duration and references, never keys, prompts, SDP, transcripts or provider bodies.
Azure and Render platform retention is separate; review their policies. The
voice request uses documented GPT-Live configuration fields, not an assumed
`store` flag; Responses requests explicitly use `store: false`.

No background server connection is needed while talking. Established media
does not intentionally depend on gateway uptime; actual Azure/device behavior
still requires live verification. A server restart, network partition or expired
close handle prevents guaranteed cleanup. Provider budget alerts are not hard
spending caps. Use Azure quotas and available spending controls.

```powershell
npm test
npm run check
npm audit --omit=dev
```

Tests use only synthetic data and a local fake HTTP/WebSocket Azure provider.
They cover authorization, validation, fixed deployments, JSON/SSE, cancellation,
duplicate/concurrency limits, sanitized errors and confirmed/unconfirmed closure.
No database, Azure credentials or paid provider calls are needed for tests.

Real deployment requires Azure resources and a Render service. A successful
test run or health check does not establish real model access, WebRTC audio
quality or Azure tool support. Keep actual paid tests bounded and separately
authorized. Roll back to the previous working Render deployment if needed;
retain signing/access secrets unless intentionally revoking existing clients.

See [plan.md](plan.md) for scope and architecture, and the official
[Azure GPT-Live WebRTC guide](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/gpt-live-webrtc),
[GPT-Live event reference](https://learn.microsoft.com/en-us/azure/foundry/openai/gpt-live-reference),
[Azure Responses guide](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/responses)
and [Render Free limitations](https://render.com/docs/free).
