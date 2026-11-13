# Mural Simple Chat Service implementation plan

Date: 2026-11-13
Status: server implemented locally; 23 fake-provider tests and syntax checks passed.
Render deployment, real Azure calls and iOS integration have not been performed.

## 1. Goal and agreed scope

Build a small **Node.js** service in this repository for a single
**Render Free web service**. Follow the core voice/helper behavior of Mural's
`services/api`, without its database and commercial features. The deliverable is
the server and its documented API; iOS implementation is out of scope.

The service will:

- Create Azure OpenAI `gpt-live-1` WebRTC sessions.
- Forward teaching/helper requests to an Azure deployment of `gpt-5.6-luna`.
- Stream helper text, support structured assessments, and request session closure.
- Keep Azure credentials exclusively on the server.
- Require a private service access token, without user registration or sign-in.

There will be **no PostgreSQL, SQLite, Redis, persistent disk, migrations,
payment integration, accounts, wallet, minute ledger, or durable usage storage**.
Existing local learning storage on the iPhone remains unchanged.

This is a personal-use service, not a replacement for Mural's commercial backend.
This plan describes the server implementation in this repository. Do not modify
the sibling Mural repository or implement client settings, routing or UI.

## 2. Findings from the existing code

Reviewed the following files in the sibling Mural checkout:

| Existing file | Relevant behavior / implication |
| --- | --- |
| `..\mural\services\api\src\main.ts` | Requires `DATABASE_URL` immediately and initializes database-backed services. It is not a suitable SQL-disabled entry point. |
| `..\mural\services\api\src\app.ts` | Hosted voice and helper routes authenticate accounts and check funded services. Do not copy these admission requirements or invent fake balances. |
| `..\mural\services\api\src\live-provider.ts` | Creates `gpt-live-1` WebRTC sessions, uses `marin`, accepts bounded instructions/history, and delegates reasoning to the client. Useful provider-adapter reference. |
| `..\mural\services\api\src\hosted-voice.ts` | Couples voice lifecycle to reservations, accounting, recovery, and a database watchdog. Reuse concepts, not this controller. |
| `..\mural\services\api\src\hosted-helpers.ts` | Uses `gpt-5.6-luna`; defines helper purposes, bounded inputs, assessment schemas, output caps, and optional search. Keep validation concepts; omit funding logic. |
| `..\mural\services\api\src\hosted-responses-transport.ts` | Fixed upstream destination, bounded responses, no automatic billed retries, and sanitized failures. Preserve these properties. |
| `..\mural\apps\ios\App\APIClient.swift` | Personal-key traffic has separate JSON and SSE paths with hardcoded OpenAI destinations. Both need private-server routing. Its current personal-key text model is `gpt-6-luna`, not the hosted backend's `gpt-5.6-luna`. |
| `..\mural\apps\ios\App\LiveTransport.swift` | Already handles WebRTC locally and forwards SDP for session creation. Waits for `session.started`; audio and protocol events do not need a gateway relay. |
| `..\mural\apps\ios\App\ConversationCoordinator.swift` | Already owns teaching prompts, transcripts, assessments, delegation, and local saves. Hosted mode checks accounts/balances before connecting; private mode must bypass that branch explicitly. |

Preserve the existing teaching policies and native WebRTC implementation. Do not
fork the language engine or move learning history into the service.

## 3. Architecture

```text
iPhone
  |
  | HTTPS: health, capabilities, SDP negotiation, helper requests, close
  | Private service token; never an Azure resource key
  v
Render Free: Node.js gateway
  |
  +-- Azure GPT-Live session creation / short-lived close-sideband control
  |
  +-- Azure Responses API: gpt-5.6-luna deployment

iPhone <========== direct WebRTC audio + data channel ==========> Azure GPT-Live

iPhone local storage: conversation history, vocabulary, preferences
Gateway: bounded transient request state only
```

The gateway does not decode, transcode, record, or relay voice audio.
It does temporarily process prompts, history and helper outputs in memory.
"No storage" means no application persistence; it does not promise that Azure
or Render have no platform retention. Review their data policies separately.

### Runtime and implementation style

- Node.js, plain JavaScript with ESM modules and JSDoc where useful.
- Pin a supported Node LTS release compatible with Render at implementation time.
- Fastify for HTTP routing and validation; native `fetch` for Azure HTTPS.
- Use `ws` only for short-lived server-side close control.
- Node's built-in test runner and a local fake Azure HTTP/WebSocket server.
- No OpenAI SDK required initially: explicit bounded requests are sufficient.
- No Docker, Caddy, database service, or compilation stage required on Render.

Keep the initial structure small: entry point/configuration, routes, Azure
transport, validation/authentication, and focused tests. Add files only when
their responsibilities warrant separation.

## 4. Azure compatibility gate

Official Azure documentation confirms `gpt-live-1` WebRTC session negotiation
through a trusted backend, at:

```text
https://<resource>.openai.azure.com/openai/v1/live/sessions
```

GPT-Live does **not** issue ephemeral client keys. Do not substitute the
different GPT Realtime API's `/realtime/client_secrets` or `/realtime/calls`
flow. The current iOS `session.*` protocol is the relevant compatibility target.

Before enabling the client:

1. Confirm actual Azure resource endpoints, region, deployment names, access and
   quotas for the two requested models. Model names are not a substitute for
   verified deployment identifiers.
2. Verify authentication independently for GPT-Live and Responses. Follow each
   documented API contract instead of blindly copying OpenAI headers.
3. Verify `marin`, client delegation, history seeding, and the
   complete iOS event/command contract against the deployed GPT-Live version.
   Do not assume a voice `store` option: send documented GPT-Live fields.
   Responses requests explicitly use `store: false`.
4. Verify the text deployment's Responses API, low reasoning effort, strict JSON
   schema, SSE event format and token limits.
5. Treat explicit prompt-cache options and web search as optional capabilities;
   do not forward OpenAI-specific options without Azure support evidence.
6. Confirm close through Azure sideband `session.close` and terminal
   `session.closed`. Do not assume OpenAI's HTTP hangup endpoint exists on Azure.

Required iOS protocol coverage: `session.started`, transcript deltas with
`start_ms`/`end_ms`, client delegation, context append commands, mute/unmute,
usage snapshots, errors, and final closure.

The server selects the deployment from configuration, never a caller-supplied
model or URL. Private-mode helper requests must not accidentally use the iOS
personal-key path's `gpt-6-luna` setting.

## 5. Proposed minimal HTTP contract

The server reads the shared private-service key from environment variable
`APIKEY`. The client supplies that same key as `Authorization: Bearer <APIKEY>`
on every `/v1/*` request. Compare against the configured value before any Azure
call using timing-safe comparison; reject missing or incorrect keys with
`401 unauthorized`. Reject a missing or empty server `APIKEY` at startup.
This shared-key check requires no accounts, sign-in or database.

`APIKEY` is a gateway credential, not an Azure OpenAI resource key. Azure
credentials remain separate and server-only. Never accept the key in query
strings, log it, or forward it upstream.

All responses use `Cache-Control: no-store`. Protocol version starts at `1`.
Keep this contract separate from Mural's commercial hosted API.

| Endpoint | Request | Response / behavior |
| --- | --- | --- |
| `GET /healthz` | None; public, non-billable | Minimal process health and protocol version; no configuration or credential details. |
| `GET /v1/capabilities` | Private token | Voice/helper availability and optional search support. Configuration-based, not a paid provider probe. |
| `POST /v1/live/sessions` | `requestID`, `sdp`, `language`, `instructions`, bounded `history` | `{ session: { id }, transport: { type: "webrtc", sdp }, closeHandle }`. |
| `POST /v1/responses` | `requestID`, `purpose`, `instructions`, `input`, optional `schema`, `search`, `stream` | Responses-compatible JSON or SSE; preserve text, citations, usage, completion and refusal semantics used by iOS. |
| `POST /v1/live/close` | `closeHandle` | Request closure through Azure sideband; report `confirmed` only after a terminal event, otherwise explicitly `unconfirmed`. |

### Voice create and close

- Allowlist languages already supported by the client; enforce bounded SDP,
  instructions, and history using the existing provider validator as prior art.
- Force the configured deployment, WebRTC transport, client delegation and voice.
- Keep audio and data-channel communication direct between iPhone and Azure.
- Return a server-signed, expiring close handle containing the validated provider
  ID and a purpose/audience. It is not an Azure credential.
- Verify its signature, size, purpose and lifetime before using its provider ID.
  Bind it to this service; do not accept arbitrary IDs or upstream paths.
- Stable signing configuration permits an authenticated close request after a
  gateway restart, without a database lookup. Expired handles cannot be used;
  document that recovery window and require the client to end before it expires.
- The client sends `session.close` on the existing data channel, waits for
  confirmation within a bounded interval, and also has the gateway close path
  for failures/cancellation. Provider closure success must not be fabricated.
- Do not keep an always-on server sideband just to hold Render awake.
- Stop input, release the microphone, and cancel helper work on end/cancellation.
  If a late create response arrives after cancellation, immediately attempt close.

### Helpers

- Preserve all seven existing purposes: `meaning`, `assessment`, `lookup`,
  `delegation`, `typed_reply`, `topic`, `help`.
- Start from the existing bounds: 64 KiB helper body, 16 KiB instructions,
  24 KiB input, bounded schema depth/nodes, and 1,400 / 2,200 output tokens.
- Assessments require the supported strict schema. Reject unsupported fields,
  arbitrary tools, remote schema references, files and background jobs.
- Streaming must preserve incremental meanings and final completion/error
  semantics, with bounded buffering and backpressure.
- Abort upstream work on disconnect/cancellation where supported. Aborting a
  request does not prove that the provider stopped work or stopped charging.
- Allow final assessment after the voice session ends; do not require a live
  session or a database funding reservation to submit a helper request.
- Search is disabled initially. Advertise this accurately, disable sourced
  current-topic selection, and retain the existing unavailable-search response
  for delegated lookups. Do not claim ordinary model text is sourced research.
  Enable search only after Azure tool availability and incremental cost are
  verified; restrict it to `topic` / `delegation` with at most one call/request.

### Failures and retries

- Return a stable envelope: `{ error: { code, reference, retryable } }`.
- Distinguish invalid requests, bad credentials, rate limits, unsupported
  capabilities, provider rejection, provider unavailability and uncertain create.
- Once SSE headers are sent, surface failure as a terminal stream error or
  incomplete stream, not a successful completed response.
- Retry only safe health/capability requests automatically.
- Never automatically replay a billed voice create or helper request after an
  ambiguous timeout. The UI explains uncertainty and requires an explicit retry.
- A bounded in-memory request-ID cache rejects duplicate attempts during one
  process lifetime. It is not durable idempotency and cannot protect across
  restarts. Do not advertise exactly-once creation.

## 6. No-database lifecycle and safety limits

No persistent storage is needed for an ordinary conversation: Azure owns its
live session and the iPhone owns conversation content and learning state.

Accept these deliberate limitations:

- Rate counters, duplicate-request protection and in-flight limits reset on
  restart; there is no durable account quota or spending ledger.
- A create that succeeds upstream but loses its response may leave an unknown
  provider session. No database or signed handle can recover an ID never received.
- A gateway restart need not interrupt an established direct WebRTC call, but
  this must be verified; helper and control requests can fail during the restart.
- The server cannot guarantee a session deadline while asleep, restarted or
  partitioned. The iPhone's existing duration/inactivity handling remains.
- Graceful shutdown aborts helpers and attempts cleanup for known unfinished
  creations. It must not pretend to close every established client-owned call.
- Azure budget alerts are not necessarily hard spending caps. Document provider
  quotas, available spending controls and manual credential revocation.

This trade-off is appropriate for private hobby use, not public paid service.

### Essential protection without accounts

- Generate a high-entropy `APIKEY` outside source control; compare the request's
  bearer key using a timing-safe mechanism. The later iOS integration lets the
  owner enter the private endpoint and this key, stored in Keychain rather than
  the app binary. Client implementation remains separate from this server task.
- Scope Keychain configuration to the exact HTTPS origin. Never forward a Mural
  account token, purchase proof or personal OpenAI key to the private service.
- Azure keys stay in Render secrets; a stable separate secret signs close handles.
- Fix upstream HTTPS origins in server configuration and allow only expected
  Azure hostnames. Reject URL userinfo, redirects and caller-selected destinations.
- No open proxy, wildcard forwarding, arbitrary tool execution or public chat UI.
- Bound request/response sizes, concurrent requests, queues and timeouts.
- Initial personal-use default: two concurrent helpers and one simultaneous
  voice-create operation. These are transient limits, not durable live-call quotas.
- Rate-limit globally/by service credential; do not blindly trust forwarded IPs.
- Log only request references, fixed operations, status, duration, deployment
  revision and sanitized provider identifiers. No authorization headers, SDP,
  audio, transcripts, prompts, helper outputs or raw provider errors.

## 7. Render Free deployment design

Use one Node web service with no database or disk resource. Render handles
public HTTPS; bind Node to `0.0.0.0` and `process.env.PORT`.

Planned deployment:

- `render.yaml`: one `type: web`, `runtime: node`, `plan: free` service.
- Build command: `npm ci`.
- Start command: `npm start`.
- Health check: `/healthz`; it must never call a paid model.
- Select a Render region reasonably close to the Azure resources.
- Keep dependencies small and commit a lockfile.
- Keep the previous working deployment available for rollback.

### Free-tier behavior the client must accommodate

As documented on 2026-11-13:

- A free service spins down after 15 minutes without inbound traffic.
- The next request wakes it; startup takes about a minute.
- Outbound calls to Azure are not a guarantee of inbound activity.
- Restarts can happen at any time and filesystem changes are ephemeral.
- There are 750 free instance hours per workspace/month, shared across services.
- Outbound bandwidth and build minutes have separate limits. High outbound API
  traffic can also trigger a service-initiated-traffic suspension.
- Free service is intended for hobby/testing, not production reliability.

The owner plans to run an external timer that requests `GET /healthz`, initially
every 10 minutes, to reduce idle spin-down. The timer must run outside this Render
process: an in-process timer cannot wake a sleeping service. The endpoint must
remain cheap and non-billable, with no Azure calls or credentials in its URL.

Check Render's applicable terms and current platform guidance before enabling
the schedule. The owner manages service availability with this external timer.
Client wake-up handling is explicitly out of scope. Missed pings, restarts,
suspension and deploys remain possible and use ordinary connection-error handling.
No Redis, database or extra Render service is needed for the timer.

Continuous operation uses up to 744 instance hours in a 31-day month, against the
750-hour workspace allocation. Other free web services share that allocation;
monitor hours, bandwidth and build usage rather than assuming unlimited uptime.

### Client availability scope

- Assume the service is available when the user starts Talk.
- Do not add a wake-up request, prewarming sequence, extended startup timeout,
  polling/backoff loop, waking indicator or cold-start-specific tests.
- Capabilities are for feature negotiation only, not a prerequisite health-poll
  sequence or an availability workaround.
- Preserve ordinary bounded connection timeouts, cancellation and explicit errors.
  Do not automatically retry billed creates or helper requests.
- A failed helper must not reconnect or stop an otherwise working voice call.
- Keep the minimal Talk layout; no additional splash or connection screen.

Recheck compute RAM/CPU allocation in Render's dashboard at deployment time.
Do not reuse the earlier full PostgreSQL-stack estimate for this gateway.
Initial measurement target: API RSS below 200 MiB with one live call and two
concurrent bounded helper requests; measure peak RSS rather than
claiming guaranteed capacity. Azure model usage is billed separately.

## 8. Server configuration

Proposed environment variables; never commit actual values:

| Variable | Purpose |
| --- | --- |
| `PORT` | Provided by Render; local default permitted. |
| `NODE_ENV` | `production` on Render. |
| `APIKEY` | Required shared private-server key; compare with the request's bearer key before any Azure call. Unrelated to Azure resource keys. |
| `SESSION_SIGNING_SECRET` | Stable, high-entropy signing key for close handles. |
| `AZURE_LIVE_ENDPOINT` | Validated GPT-Live resource origin. |
| `AZURE_LIVE_API_KEY` | Server-only voice resource credential. |
| `AZURE_LIVE_DEPLOYMENT` | Verified deployment of `gpt-live-1`. |
| `AZURE_RESPONSES_ENDPOINT` | Validated Responses resource origin; may match voice. |
| `AZURE_RESPONSES_API_KEY` | Server-only helper resource credential. |
| `AZURE_RESPONSES_DEPLOYMENT` | Verified deployment of `gpt-5.6-luna`. |
| `ENABLE_WEB_SEARCH` | `false` by default; only enable after compatibility checks. |

Use constants for initial limits rather than adding unnecessary configuration.
Fail startup for missing secrets, invalid endpoints or contradictory settings.
Readiness reflects validated local configuration, not assumed Azure availability.

## 9. Client boundary: reference only

The existing iOS code informs the server's SDP, event, helper JSON and SSE
contracts. It is not an implementation target for this task.

- Document request/response examples and private-token authentication.
- Document that audio/data events go directly between the client and Azure.
- Document caller responsibilities for cancellation, context, session closure
  and local learning data, without adding client code.
- Do not modify iOS providers, settings, Keychain, UI, account flows, purchases,
  prompts, local storage or the existing Mural backend.
- No client wake-up feature or client build/test deliverable.
- State clearly that the existing app needs separate integration; the new server
  is not automatically a drop-in replacement for the account-funded hosted API.

## 10. Implementation sequence

### Phase 1: configuration and Azure contract

- Verify deployment identifiers, supported options and close behavior.
- Freeze protocol version 1 and representative request/response fixtures.
- Record search as unavailable until independently verified.
- Do not require paid calls for local scaffolding or unit tests.

### Phase 2: Node.js gateway in this repository

- Implement validated configuration, auth, safe logging and health/capabilities.
- Implement bounded voice creation and signed-handle close.
- Implement validated JSON/SSE Responses forwarding with cancellation.
- Add bounded transient concurrency, duplicate-request and rate protection.
- Add shutdown handling, fake-provider tests and deployment instructions.
- Add `.env.example`, package scripts/lockfile and `render.yaml`.

### Phase 3: Render deployment and server verification

- Deploy the tested service with private secrets when deployment access is provided.
- Verify the exact deployed revision, TLS, health, auth rejection and capabilities.
- Configure the owner's external health-ping timer and verify successful requests;
  document where the schedule runs and how to disable it.
- Perform authorized, bounded paid Azure checks separately from non-billable
  deployment probes; no purchase, sign-in or commercial backend deployment needed.
- Validate the server's Azure contract, restart/error and closure behavior.
- Record rollback revision, verification results and remaining free-tier limits.
- No merge, app publication or paid-provider test is authorized by this plan alone.

## 11. Verification and acceptance criteria

### Offline gateway checks

Planned commands: `npm test` and `npm start` with fake-provider configuration for
smoke checks. Define a test script using `node --test`. No SQL or Azure credentials
are required for unit/transport tests.

Cover:

- Startup without any database configuration or database dependency.
- Missing/invalid token, signed-handle tampering/expiry and endpoint restrictions.
- Payload limits, malformed SDP/history/schema and caller-selected model rejection.
- Correct Azure URL/auth/deployment mapping using a fake upstream.
- JSON and SSE text, citations, structured assessments, refusals and failures.
- Oversized responses, backpressure, client disconnect and request cancellation.
- No automatic replay after ambiguous create/helper timeouts.
- In-memory duplicates/concurrency limits and their documented restart behavior.
- Close confirmation versus timeout, and handle verification across process restart
  with the same signing secret.
- Logs exclude secrets and conversation content.

### Client contract checks

Use representative request/response fixtures based on the existing iOS client
to validate the server contract. No Swift changes, Xcode build, simulator tests
or iPhone setup are required to deliver this server.

### Deployment/provider checks

- Non-billable: public health, invalid-token rejection, private capabilities,
  deployed revision, safe logs and absence of database/disk dependencies.
- After separate live-test authorization: Azure SDP negotiation, helper JSON/SSE,
  structured assessment and confirmed session closure using a bounded test client.
  Real iPhone audio/UI and teaching-quality checks are separate integration work.
- Verify the external timer only calls the non-billable health endpoint.
- Verify a long conversation whose gateway restarts; audio must not be
  deliberately relayed through Render.
- Measure process RSS/CPU for the stated workload and verify bounded allocations.
- Keep live tests short and distinguish protocol checks from teaching quality.

Server implementation is complete when its documented API and failure behavior
pass the offline contract/transport tests and the deployment configuration is
ready. Report local tests, Render deployment and real Azure verification
separately; do not claim unperformed live checks. iOS integration is not a
completion requirement.

## 12. Sources and remaining deployment inputs

Public documentation checked on 2026-11-13:

- [Azure GPT-Live overview](https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/gpt-live)
- [Azure GPT-Live WebRTC](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/gpt-live-webrtc)
- [Azure GPT-Live events, sideband and close](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/gpt-live)
- [Azure Responses API and supported models](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/responses)
- [Render Free limitations](https://render.com/docs/free)
- [Render web services and port binding](https://render.com/docs/web-services)
- [Render Blueprint specification](https://render.com/docs/blueprint-spec)

Remaining inputs before real deployment: Azure resource/deployment identifiers
and access, Render repository/service configuration and region, and private
service/signing secrets. Enter credentials through local private settings or
hosting secrets, never this plan or source.

## 13. Implementation verification (2026-11-13)

- Implemented the Node.js gateway, `APIKEY` authentication, signed close handles,
  Azure adapters, bounded JSON/SSE, cancellation, transient admission and safe logs.
- Added `.env.example`, lockfile, Render Free Blueprint and API/run documentation.
- `npm test`: passed, 23 tests, no failures or skips. Transport tests use only a
  local fake Azure HTTP/WebSocket server and synthetic content.
- `npm run check`: passed JavaScript syntax checks.
- `npm audit --omit=dev`: passed, zero known vulnerabilities.
- Real localhost HTTP smoke: health, fake SDP negotiation and two simultaneous
  helper requests passed. Sample process RSS was 62.9 MiB, below the 200 MiB
  planning target. This is not a production capacity or real Azure benchmark.
- No SQL service was configured or used. Test listeners were closed.
- No sibling Mural/iOS files were changed. No commits, pushes, Render deployment
  or paid Azure calls were performed.
