# Prototype 2 — salesperson-assisted AI conversation

This document describes the architecture as implemented in this branch, the
root cause of the broken human-to-human audio, the authorization model, the
three media paths, the tests that were actually executed, and the remaining
limitations.

## 1. Routes and participant interfaces

| Route | Who | Component | Renders |
| --- | --- | --- | --- |
| `/sales` | Salesperson | `src/components/prototype2/SalespersonDashboard.tsx` | Active call as the main focus (call icon, status, controls), customer speech, private AI suggestions, invitation screen, diagnostics on demand |
| `/join?invite=<token>` | Customer | `src/components/prototype2/CustomerDashboard.tsx` | Invitation redemption, join/leave, mic + speaker controls, connection status, salesperson captions |
| `/` | Demo/operator | `src/App.tsx` | Prototype selector; the Prototype 2 tab hosts the salesperson dashboard |

The customer route never renders the salesperson dashboard, the prototype tab
bar, AI status or error text, "AI heard"/listening indicators, AI suggestion
cards, private notes or diagnostics. The salesperson route never renders the
customer join screen. **A URL parameter such as `?role=customer` grants
nothing**: `/` with `?prototype=2&room=...&role=customer` renders an explicit
"invalid invitation" customer screen, and any `/sales` visit creates or restores
*that browser's own* session using a stored secret.

### Customer privacy is enforced server-side

* The customer's `joined` / `session_state` payload is built by `stateFor()`,
  which strips the internal `aiReady` flag (evidence that an Ultravox call
  exists) and the invitation-redeem response does the same.
* `ai_suggestion` and `customer_speech_transcript` are customer-only senders and
  are relayed to the salesperson only; `salesperson_caption` is
  salesperson-only and relayed to the customer only. Any other sender gets
  `INVALID_SIGNALING_ROLE`.
* The customer UI renders no AI state at all. AI recovery (retry) happens in the
  background without surfacing AI status or errors.
* Limitation: the Ultravox session runs in the customer's own browser (the
  preserved architecture), so the AI text is produced on that device. It is
  never *rendered* there and never returns over signaling, but the server cannot
  withhold a value that the customer's own page generated.

### Invitations are separate from calls

`/sales` creates an invitation and then shows a dedicated invitation screen
(link, Copy Link, Back to Dashboard). Creating another invitation calls
`POST /api/sessions` and never rotates, revokes, disconnects or replaces the
session of an active call; the dashboard keeps its own session and engine, and
"Back to Dashboard" returns to it.

## 2. Authorization and session model

`server/sessionStore.ts` is the single source of truth. Everything is in process
memory.

```
POST /api/sessions                     -> { sessionId, salespersonKey, inviteUrl }
GET  /api/sessions/:id                 (Bearer salespersonKey) -> session state
POST /api/sessions/:id/invitations     (Bearer salespersonKey) -> rotate invite
POST /api/sessions/:id/invitations/revoke (Bearer salespersonKey)
GET  /api/sessions/:id/diagnostics     (Bearer salespersonKey) -> server view
POST /api/invitations/redeem           { inviteToken, customerKey? } -> customerKey
POST /api/sessions/:id/ultravox-call   (Bearer customerKey) -> { joinUrl }
GET  /api/sessions/:id/ice-config      (Bearer participant credential) STUN/TURN
GET  /api/health                       capability flags only (no keys)
WS   /ws                               join + signaling relay
```

* `sessionId` is 128 bits of randomness.
* `salespersonKey` / `customerKey` / `inviteToken` are 256-bit random values.
  Only SHA-256 hashes are stored; comparisons are constant time.
* The invitation is **single-use** and **bound to one session**: the first
  redemption mints a customer key. A second browser using the same link is
  rejected (`INVITE_REDEEMED`) until the salesperson rotates the invitation.
* Roles are derived from which credential matched. A `role` claim that
  contradicts the credential is rejected with `ROLE_MISMATCH`.
* WebSocket joins must present the credential in the first message
  (`type: "join"`). Unauthenticated sockets are closed after 10 s. Sockets that
  never joined can never relay anything.
* Every signaling message is relayed only to the counterpart of the same
  session. Messages carrying another `sessionId` are rejected (`WRONG_SESSION`),
  and missing peers produce `signal_error` / `PEER_UNAVAILABLE` plus a counter.
* Reconnects present a per-connection resume token. The participant id is reused
  (`connectionCount` increments) instead of creating a duplicate participant. A
  new socket with the same identity supersedes the old one (code 4001).
* Logs never contain tokens; `/api/health` and diagnostics never contain a key,
  an invite token, or audio content. The Ultravox API key never leaves the
  server; the browser cannot supply one.

### Known storage limitation

Sessions, invitations and participants live in one Node process. A Render
restart/redeploy destroys them: the salesperson gets a new session and the old
invitation stops working. There is no persistence layer and no claim of
recovery after restart. This is acceptable for the current single-instance
deployment; a multi-instance deployment would need a shared store (Redis/Postgres)
and sticky WebSocket routing.

## 3. Media architecture (WebRTC, direct peer-to-peer)

One `RTCPeerConnection` per participant, created by `src/lib/callEngine.ts`.

```
Salesperson browser                          Customer browser
  mic --addTrack-->  RTCPeerConnection  <--addTrack-- mic
  <audio> <--ontrack--      |                        |--ontrack--> <audio>
                            |                        |
                            +--- WebSocket relay ----+
                                    (SDP + ICE)

                                     Customer browser
  mic --getUserMedia (2nd capture)--> UltravoxSession --> LiveKit --> AI
  AI text --transcript--> WebSocket --> server --> salesperson dashboard
```

* **Offerer**: salesperson only. **Answerer**: customer only. This removes glare
  by construction and is enforced again server-side (`offer` from a customer is
  rejected). A joining/reconnecting peer triggers `peer_joined`, which forces the
  salesperson to build a fresh connection and send a new offer.
* Presence refreshes (`session_state`) are a liveness hint only: they neither
  create an offer nor recreate a peer connection. An offer in flight is tracked,
  so a second offer is never created while `signalingState` is
  `have-local-offer`. An unanswered offer is rolled back after a bounded timeout
  and retried (at most 3 offers per negotiation), then the connection becomes
  terminal.
* `pc.connectionState === "failed"` or a failed ICE state starts **one** bounded
  recovery sequence: up to 3 ICE restarts with backoff. Duplicate failure events
  from `connectionState` and `iceConnectionState` are coalesced. A
  `disconnected` state gets a short grace period and may recover on its own.
  The customer cannot create an offer, so it asks the salesperson through the
  role-checked `ice_restart` signaling message.
* Only a genuine `connected` transport (ICE + DTLS) resets the recovery budget.
  If every attempt fails, the call reports an actionable terminal error and no
  longer recreates peer connections on presence updates. `Reconnect` (or
  `retryConnection()`) deliberately starts one fresh negotiation inside the same
  page/call. WebRTC failure never stops a healthy Ultravox AI session.
* Microphone `mute`/`ended` events (mobile browsers can end a track when a second
  capture starts) trigger reacquisition and `replaceTrack`. Remote-track and
  peer-connection callbacks are generation-guarded and cleared on teardown.
* Closing a peer connection no longer stops the shared microphone track — that
  was one of the reconnect bugs found by the browser tests.
* Remote audio is attached to a persistent `<audio>` element that is primed with
  a silent WAV *inside the Join click*, so iOS/Safari allow subsequent playback.
  A blocking banner with an "Enable audio" button recovers if playback is still
  refused.
* ICE/TURN configuration is fetched **before** any peer connection is created,
  from `GET /api/sessions/:id/ice-config`, authenticated with the participant's
  salesperson or customer credential. Anonymous and cross-session requests get
  401. The payload is applied to every `RTCPeerConnection`, including reconnects
  and ICE restarts.
* The ICE request is bounded (8 s) and transient failures (a dropped request, a
  cold server, 5xx/429) are retried with a short backoff. If the payload still
  cannot be read, a normal (`all`) deployment continues with direct-connection
  STUN defaults instead of failing the call; only `ICE_TRANSPORT_POLICY=relay`
  fails closed. The technical reason stays in the salesperson diagnostics/server
  log, never in the customer UI.
* Before every ICE restart (and on a manual retry) the ICE payload is re-read so
  expiring provider-issued TURN credentials are refreshed and applied to the
  live peer connection with `setConfiguration`.
* A peer connection that never reaches `connected` is bounded: a 20 s watchdog
  and zero-candidate ICE-gathering detection both start the same bounded
  recovery sequence, so participants are never left on "connecting" forever.
* TURN modes: coturn `TURN_SECRET` (short-lived HMAC credentials, preferred),
  static `TURN_USERNAME`/`TURN_CREDENTIAL`, a managed provider's credentials
  API (`TURN_CREDENTIALS_URL`, GET or POST+`{ttl}`), rstream's Control plane
  TURN issuance (`RSTREAM_AUTHENTICATION_TOKEN` + `RSTREAM_PROJECT_ENDPOINT`),
  static rstream JSON credentials for temporary testing
  (`RSTREAM_TURN_USERNAME`/`RSTREAM_TURN_CREDENTIAL`/`RSTREAM_TURN_URLS`, which
  expire and must be replaced manually), or ExpressTURN static credentials
  entered by the operator at `/admin/turn` and held only in server memory.
  The operator creates the `/admin/turn` setup password in the browser on first
  use (stored as a salted scrypt hash, never as plaintext and never in an
  environment variable); later changes require that password, a signed
  `HttpOnly`/`SameSite=Strict` session cookie and a per-session CSRF token.
  Credentials and the setup hash disappear together on restart, returning the
  page to first-time setup. Credentials are never logged and never appear in
  `/api/health`.
* `ICE_TRANSPORT_POLICY=relay` without a usable relay is a hard failure: the ICE
  endpoint returns 503 `TURN_MISCONFIGURED`, the engine refuses to create a peer
  connection or capture the microphone, and the dashboard shows the reason.
  There is no silent STUN-only fallback.
* A relay entry that `server/turn.ts` classifies as unusable (invalid/partial
  URLs, missing authentication or expired static credentials) is withheld from
  the `iceServers` payload, so a browser never attempts an allocation that
  cannot succeed and never receives a credential that is useless.
* Customer-visible copy never contains ICE/TURN/SDP values, candidate data,
  HTTP statuses, API error codes or signaling diagnostics. Those stay in the
  salesperson dashboard, the engine log and the server log.
* Without TURN, carrier-NAT/mobile-data pairs still cannot connect; diagnostics
  show `relay candidates 0`, `selected pair host→srflx` and the amber TURN banner.

### The communication paths

| Path | Transport | Implementation |
| --- | --- | --- |
| A. Customer → AI → salesperson dashboard | Ultravox/LiveKit + WebSocket text relay | Customer runs the `UltravoxSession`; agent transcripts are sent as `ai_suggestion`; the server relays them only to the salesperson of that session |
| B. Salesperson → customer | WebRTC audio track | Salesperson mic is `addTrack`ed to the PC; the customer's `<audio>` plays it |
| C. Customer → salesperson | WebRTC audio track | Customer mic is `addTrack`ed to the PC; the salesperson's `<audio>` plays it |
| D. Salesperson speech caption → customer | Browser `SpeechRecognition` + `salesperson_caption` text relay | The salesperson's browser transcribes its own microphone locally and sends text; the server relays it to the paired customer only. The salesperson microphone is never published to Ultravox and never mixed into the customer's AI audio path. |

If the browser has no `SpeechRecognition` (Firefox, some Safari builds), the
salesperson dashboard reports "Captions unavailable in this browser" and the
call continues normally; the customer simply sees no captions. Muting the
salesperson pauses recognition.

AI output is **text-only** in Prototype 2 (`Medium.TEXT` + `muteSpeaker()`), so
the AI can never talk over the salesperson. The salesperson has no Ultravox
session at all, so salesperson speech cannot enter the AI pipeline.

### AI session lifecycle and recovery

`ultravox-client@0.6.0` manages one finite Ultravox call per `UltravoxSession`.
A join URL belongs to that call. When the call's WebSocket closes, the SDK emits
an `error` event (for code 1006: `Session socket closed abnormally. code=1006
reason=…`), then `disconnecting` → `disconnected`. It does **not** reconnect,
and the same join URL cannot revive the ended call. Recovery therefore means
*create a new Ultravox call and a new SDK session*, never retry the old URL.

The lifecycle is implemented as:

* `POST /api/sessions/:id/ultravox-call { replace: true }` discards the session's
  cached call record, best-effort `DELETE`s the superseded provider call, and
  creates a new one. The client always sends `replace: true`; the no-body form
  remains for idempotent reads. Concurrent creations for one session return
  `409 ULTRAVOX_CALL_IN_PROGRESS`.
* Every AI attempt gets a monotonically increasing generation. All SDK callbacks
  (`status`, `transcripts`, `error`) and the 20 s connect timeout ignore events
  from an older generation, so a dead session cannot overwrite a new one.
* Automatic recovery is bounded to 3 attempts with 1.5 s / 4 s / 9 s backoff. A
  session that stayed live for ≥ 60 s earns a fresh budget. After the bound the
  dashboard shows the real provider error plus "recovery stopped after 3
  attempts"; it never shows a false connected state.
* The customer device reports its real state over `ai_status`; the server stores
  it (`session.ai`) and relays it to the salesperson. The salesperson's **Restart
  AI** button sends `ai_reconnect` back over signaling; only the customer device
  can create the AI session because only it holds the microphone.
* `ai_status` is observational: if the salesperson is offline it is still stored,
  and it is hydrated into the salesperson dashboard from `joined` /
  `session_state` / the 5 s session poll.
* AI failure never touches the `RTCPeerConnection`; the salesperson <-> customer
  audio call, TURN configuration and signaling reconnect loops are independent.

### AI status shown to the salesperson

The salesperson dashboard has a dedicated **AI copilot status** panel (and a
header chip) fed by the customer's reported state:

* Creating AI session / Connecting AI / AI connected / Reconnecting AI /
  AI disconnected / AI session closed / AI not started / AI error
* the latest safe failure text (join URLs and token-looking values redacted)
* whether reconnection is in progress and the attempt number
* whether the customer microphone is actually published to the AI
* the last AI response time
* whether a server-side Ultravox call record exists — explicitly labelled
  "not proof of connection"

`aiReady`/`GET /api/health.ai.ready` remain *capability/record* flags. They are
no longer used as evidence of a live session.

### Duplicate customer capture: trade-off

The customer device captures the microphone twice: once for Ultravox (internal to
the SDK, not replaceable through its public API in `ultravox-client@0.6`) and
once for the peer connection. This is the one unavoidable duplication:

* Routing the Ultravox `micSourceNode` into the PC would require a renegotiation
  initiated by the answerer, adding glare handling and an AudioContext that may
  be suspended on mobile — higher risk than the duplication itself.
* The engine detects the known failure mode (the browser ending/muting the P2P
  track when the second capture starts) and recovers the outbound track.
* Muting the customer mutes **both** paths (`track.enabled = false` +
  `UltravoxSession.muteMic()`), because a customer who believes they are muted
  must not be transcribed.

Echo: the customer may hear the salesperson through the device speaker while the
microphone picks it up. Browser echo cancellation is enabled on the capture;
headphones remove the residual risk.

### Verified audio path guarantees

Direction by direction, the participant path guarantees:

1. **An outbound audio m-line always exists.** The peer connection is created
   with the microphone attached (`addTrack`) or, when no live capture exists yet,
   with a `sendrecv` audio transceiver. A microphone acquired later is attached
   with `replaceTrack`, so a late/denied-then-granted capture cannot leave a
   "connected but one-way silent" call. Using `replaceTrack` also avoids a
   renegotiation race with the single-offerer policy.
2. **One capture per participant.** Re-acquiring the microphone stops the
   previous `MediaStreamTrack`. Without that, a recovered call left the old
   capture hot (privacy) and competing with the new one (the second concurrent
   capture is what mutes the P2P track on some mobile browsers).
3. **A connected transport is not a working call.** After ICE+DTLS connect, the
   engine keeps sampling `getStats()`. If no inbound RTP ever arrives (grace
   8 s) or media stops for 20 s, it starts the bounded recovery sequence **with
   `force`**, which refreshes the TURN payload and performs an ICE restart.
   Without the force flag `runRecoveryAttempt()` would just re-report
   `connected`. The restart budget is not reset until audio is observed again,
   so a path that reconnects silently fails honestly instead of looping.
4. **Background tabs are excluded** from the stall decision, because a throttled
   timer is not evidence of lost media.
5. **Direction diagnostics.** The snapshot exposes `diagnostics.audioFlow`
   (`both` / `inbound-only` / `outbound-only` / `none`) and
   `diagnostics.lastMediaAgoMs`; the salesperson panel renders both. "I can hear
   them but they cannot hear me" is now a readable state, not a guess.

## 4. Diagnostics

Both dashboards show a details panel with:

* role, participant id, session id and session expiry
* WebSocket state and reconnect attempt counter
* peer-connection, ICE connection and ICE gathering state
* selected local/remote candidate types, relay flag, gathered candidate counts
* microphone permission, track state (including `disabled`), sender count
* remote track state, RTP bytes sent/received and kbps, `<audio>` paused/muted state
* autoplay error text
* AI lifecycle state, raw SDK status, call id, reconnect attempt, whether the
  customer mic actually reaches the AI, last AI response time, and the safe
  provider failure text (never a join URL or token)
* the engine event log

`window.__prototype2.getSnapshot()` exposes the same data to support tooling and
the automated browser tests.

The client also pushes a sanitised `client_diagnostics` message every 5 s. The
salesperson's diagnostics endpoint merges this with server-side counters:

* offers / answers / ICE candidates relayed
* AI suggestions relayed
* rejected messages and relay failures with the last server error
* per-participant connected state, `connectionCount`, last seen
* TURN presence and ICE policy, Ultravox key presence (boolean only)

This lets the backend identify a routing/signaling failure (e.g. `relayFailures`
rising while `answers` stays 0) without reading the frontend console.

## 5. Tests actually executed

| Command | What it covers | Result |
| --- | --- | --- |
| `npm run test:unit` | `SessionStore`: session/credential isolation, role mismatch, single-use invitation, rotation/revocation, expiry, resume identity, duplicate prevention, AI call clearing, AI liveness vs call record, no plaintext secrets | 13/13 pass |
| `npm run test:turn` | ICE/TURN unit tests (synthetic env + mocked provider HTTP): URL parsing, static/ephemeral/provider credentials, HMAC correctness, relay-only fail-fast, provider caching/failure, no secret leakage | 17/17 pass |
| `npm run test:signaling` | Real HTTP + WebSocket server: join authentication, role enforcement, offer/answer/ICE relay including the customer's role-checked `ice_restart` request, AI text relay to the salesperson only, cross-session isolation, reconnect identity, `peer_left`, invalid JSON, diagnostics authorization, customer-only Ultravox call, **AI call rotation, failed-creation retry, AI status relay/role enforcement/redaction, customer-disconnect AI state**, authenticated ICE endpoint, TURN static/ephemeral/provider delivery, relay misconfiguration, APP_URL, AI readiness without a key, secrecy | 31/31 pass |
| `npm run test:negotiation` | Deterministic fake WebRTC/WebSocket: repeated `session_state` never creates a duplicate offer, no offer while `have-local-offer`, queued ICE restart runs when stable, an unanswered offer is rolled back and retried within a bounded budget, signaling-send/createOffer/setLocalDescription failures each consume one bounded attempt, bounded recovery reaches terminal with no busy loop, a later attempt within budget can recover, watchdog never rolls back an in-flight answer, a failed answer re-arms the watchdog, stale-peer answers cannot cancel a new watchdog, signaling rejoin after terminal starts a fresh negotiation, duplicate failure events coalesce, no PC churn after terminal, replacement cancels timers/ignores stale callbacks, customer restart request path, transient disconnect, AI independence | 17/17 pass |
| `npm run test:ai` | **Mocked `UltravoxSession` + mocked `fetch`**: new-call-per-retry, connected only from live SDK status, mic-published reporting, abnormal-close recovery, stale-callback isolation, bounded retries with real error text, duplicate-retry suppression, salesperson restart over signaling, AI failure leaves WebRTC state untouched | 8/8 pass |
| `npm run test:browser` | Chromium, two isolated browser contexts, synthetic media: role-specific UIs, invitation scoping/replay rejection, legacy URL rejection, bidirectional RTP, `<audio>` playing, mute/unmute on both sides, reconnect without duplicate participants/tracks, **presence-refresh flood smoke test (real Chromium; the deterministic suite is the D1 regression proof)**, AI text on the correct dashboard, AI failure isolated **and visible on the salesperson dashboard**, **salesperson-triggered AI restart without dropping audio**, **rotated invitation creates a new AI call**, server-side client diagnostics, TURN applied to every PC (incl. reconnect), relay-only policy applied, relay-only-without-TURN refuses to start, no credential leakage in DOM/snapshot | 22/22 pass |
| `npm run build` | Production Vite build | pass |
| `npm run lint` | `tsc --noEmit` | pass |

### What synthetic tests do NOT prove

Chromium's fake audio device proves that signaling, negotiation, track routing,
RTP flow and element playback work. It does **not** prove acoustic quality,
speaker/microphone behaviour, echo, Bluetooth routing, iOS autoplay, or
connectivity across carrier NATs. Those require the two-device plan below.

The AI lifecycle tests use a **fake `UltravoxSession` and a mocked provider
HTTP call**. They prove that the app requests a new call instead of reusing a
dead join URL, isolates stale callbacks, bounds retries and reports state
truthfully. They do **not** prove a real Ultravox session connects or that a
real provider 1006 close recovers. That needs `ULTRAVOX_API_KEY` plus network
access, and is part of the manual verification below.

## 6. Root cause of the reported failure

1. **No participant/session identity.** Roles came from a URL query parameter
   and any browser could join any free-form `roomId` as either role, so there
   was no reliable binding between the salesperson who created the "room", the
   invited customer, and the two peer connections. Two browsers opening the same
   URL in different orders could end up with no counterpart, and there was no
   server-side way to tell why.
2. **No invitation/session lifecycle.** `/api/room/ultravox-call` and the AI
   status were keyed by a guessable room string, and the client could supply the
   Ultravox key. Sessions could not expire, be revoked, or be isolated.
3. **Media fixes alone could not help.** PR #2 correctly added TURN, autoplay
   priming, track recovery and diagnostics, but the connection still depended on
   both browsers independently agreeing on the same free-form room, and it
   stopped the shared microphone track when a peer connection was rebuilt —
   which is why a reconnect left a "connected" call with no audio.
4. **Reconnects did not renegotiate.** A reconnecting participant kept the same
   identity, so the other side saw "presence refreshed", kept its old
   `RTCPeerConnection`, and never sent media to the newcomer.

Both media bugs (3 and 4) were reproduced and fixed while running the browser
suite, which is why the reconnect and mute assertions exist.

### Confirmed root cause of the AI session failure (this change)

5. **The server cached one Ultravox call per session forever.** Every
   `POST /api/sessions/:id/ultravox-call` returned the same `joinUrl` with
   `isReused: true`. Ultravox calls are finite (`maxDuration: 3600s`, provider
   close, network loss). Once the call ended, that URL was dead.
6. **The SDK cannot reconnect, and the client never created a new call.**
   `ultravox-client@0.6.0` emits `Session socket closed abnormally. code=1006
   reason=…` and goes to `disconnected`; there is no reconnect API. `retryAi()`
   asked the server again, received the same dead URL and failed again. Rotating
   the invitation kept the same session, so it received the same dead URL too —
   which is why new invitations did not restore the AI.
7. **No automatic recovery, no status surface.** After the `error` event the
   customer dashboard showed an error, the salesperson dashboard showed nothing
   (the AI only exists on the customer device), and `aiReady` kept saying yes
   because it only meant "a call record exists". Old listeners were never
   detached, so a late event from the dead session could overwrite a new one.

The precise production close code is not independently confirmed (no provider
logs were available). The code path is confirmed from the installed SDK source
and the provider contract; the dashboard now reports the code/reason verbatim
when it occurs.

### Deployment causes (separate from the audio bug)

* `vite: not found` happened because the repository had no `package-lock.json`,
  so Render never installed dependencies before running the build.
* `ERESOLVE` came from an unused direct `esbuild@^0.25` devDependency conflicting
  with Vite 8's optional peer `esbuild@^0.27 || ^0.28`.
* `tsx` (required by `npm start`) lived in devDependencies, so a production
  install could not start the server.

See [deployment.md](./deployment.md) for the exact fix and Render settings.

### Production participant-audio diagnosis (live evidence)

`GET https://ultraviolet-coplit.onrender.com/api/health` on the deployed service
returns (checked while working on PR #12):

```json
{ "ice": { "configured": false, "credentialMode": "none",
           "iceTransportPolicy": "all",
           "warnings": ["No usable TURN relay is configured. Calls work only when
             both devices can reach each other directly; mobile-data or
             symmetric-NAT participants will have no audio."] },
  "hasTurn": false, "publicAppUrl": null,
  "appUrlWarnings": ["APP_URL is not set ..."], "uptimeSeconds": 20 }
```

Conclusions that are supported by that response:

1. The running process has **no TURN relay at all**, so participant media can
   only use direct host/srflx candidates. One side of a call from a
   CGNAT/mobile/symmetric-NAT network gets no media path; the AI path still
   works because Ultravox/LiveKit uses its own relay infrastructure.
2. The ExpressTURN settings are **process memory only**. `uptimeSeconds: 20`
   shows a fresh process (Render spin-down/wake-up or a redeploy), so anything
   entered at `/admin/turn` earlier is gone and must be re-entered after every
   restart.
3. `APP_URL` is unset, so invitations fall back to the request host. Not an
   audio cause, but it must be configured for a stable public origin.

What cannot be concluded from the health endpoint: whether ExpressTURN accepts
the operator's credentials, whether a relay candidate was gathered, or what the
selected candidate pair was. Those need `/admin/turn` to be configured and a
real two-network call; `relay candidates > 0` plus a `relay` selected pair in
the salesperson panel is the only local proof that the relay works.

## 7. Environment variables
| Variable | Required | Purpose |
| --- | --- | --- |
| `ULTRAVOX_API_KEY` | yes | Server-side Ultravox call creation. Never sent to clients. |
| `APP_URL` | recommended | Public origin used to build invitation links (Render URL). Falls back to the request host. |
| `TURN_URLS` | for cross-network audio | Comma-separated `turn:`/`turns:` URLs |
| `TURN_SECRET` | preferred TURN auth | coturn shared secret; minted per-session credentials |
| `TURN_TTL_SECONDS` | optional | Credential lifetime (default 3600) |
| `TURN_USERNAME`, `TURN_CREDENTIAL` | static fallback | Long-lived relay credentials (not per-session) |
| `TURN_CREDENTIALS_URL`, `TURN_CREDENTIALS_AUTH`, `TURN_CREDENTIALS_METHOD` | managed provider | Server-side fetch of temporary credentials |
| `STUN_URLS` | optional | Overrides the default Google STUN servers |
| `ICE_TRANSPORT_POLICY` | optional | `all` (default) or `relay` |
| `MAX_SESSIONS` | optional | Cap on in-memory sessions (default 500) |
| `PORT` | Render-provided | HTTP/WS port |

No new environment variables are required for the AI lifecycle fix. The same
`ULTRAVOX_API_KEY` is used for call creation and for the best-effort termination
of superseded calls.

Render: keep the existing web service (`npm start`, build `npm run build`,
`NODE_ENV=production`). Build/start commands and the dependency strategy are
documented in [deployment.md](./deployment.md); `/api/health` exposes
`ice.configured`, `ice.credentialMode` and AI readiness without any secrets. A
TURN relay (coturn on a VPS, or a managed provider) is the only external service
that must be added.

## 8. Remaining limitations

* In-memory sessions: restart/redeploy loses sessions and invitations.
* Single instance only; no shared state across Render instances.
* No real TURN relay was available during development: relay media flow is NOT
  verified. Static and short-lived credential generation, provider fetching (with
  mocked HTTP) and the relay-only fail-fast path are covered by automated tests.
* The deployed Render service currently reports `hasTurn: false` (see §6), so
  participant audio across networks cannot work there until `/admin/turn` is
  configured. Because those settings live only in process memory, they must be
  re-entered after every restart/spin-down/redeploy.
* Silent-call detection is derived from RTP counters (`getStats()`), not from
  decoded acoustics, in production. The automated tests do decode the received
  audio, but only in Chromium on the same host.
* The customer device still captures the microphone twice (participant path +
  Ultravox SDK), so the AI capture competes with the participant capture on
  hardware that allows only one capture at a time. Now the engine releases stale
  captures and recovers the participant track, but it cannot share one capture
  with the SDK's public API.
* Static TURN credentials, when used instead of `TURN_SECRET`, are delivered to
  every authorized browser and cannot be rotated per session.
* Managed-provider response shapes are covered by mocks; no live vendor API was
  exercised (that requires an account and credentials).
* No live Ultravox session was exercised in automated tests. The recovery path is
  verified against a fake SDK session and a mocked provider HTTP call; real
  provider connectivity and a real 1006 close still need the manual check below.
* A superseded Ultravox call is ended with a best-effort `DELETE`; if that call
  fails the orphaned call ends at its provider `maxDuration` (1 h). Stopping the
  page while a call-create request is in flight can also leave a short-lived
  orphan for the same reason.
* Customer credentials live in `sessionStorage`; clearing site data or opening the
  link in another browser requires the salesperson to rotate the invitation.
* The invitation is single-use by design; this is a deliberate anti-hijack
  trade-off and must be explained to whoever operates the demo.
* The customer microphone is captured twice (see above).
* AI responses are text-only; the AI has no voice in Prototype 2.
* No recording, no transcript persistence, no analytics.
* Rate limiting is a per-process in-memory bucket on invitation redemption only.

## 9. Manual two-device verification (still required)

Use one desktop/laptop (salesperson) and one phone on mobile data (customer).

1. Open `https://<render-url>/sales` on the laptop. Confirm a session id and an
   invitation link appear.
2. Tap **Start microphone & connect**. Allow microphone access. Status should
   read "Waiting for customer".
3. Copy the invitation and open it on the phone. Confirm the customer screen
   (not the salesperson one) and that the session id matches.
4. Tap **Join call with microphone** and allow access. Both sides should reach
   "Audio connected" within a few seconds.
5. Speak on the phone: the laptop must play the customer's voice. Speak on the
   laptop: the phone must play the salesperson's voice. Use headphones on the
   laptop to avoid echo.
6. Open **Show details** on both devices and confirm:
   * `rtp out` and `rtp in` increase on both sides
   * `playback` is `playing`, `autoplay error` is `none`
   * `senderTracks`/`senders` is `1`
   * on the phone `path` shows `relay` when `TURN_URLS` is configured and the
     devices are on different networks; `relay 0` + `srflx` means TURN is not in
     use and mobile-data calls may fail
7. Ask a question and confirm a suggestion appears in **AI copilot responses** on
   the laptop while the audio call keeps flowing. The AI text must never appear
   on the phone's salesperson panels.
8. Toggle the customer's mic: the laptop should stop receiving speech, the AI
   status should stop producing new text, and the connection must stay
   "Audio connected". Toggle the salesperson's mic: the phone should stop
   receiving speech and the customer's mic must remain unaffected.
9. Reload the phone tab, rejoin, and confirm the laptop reconnects automatically
   (one customer, one salesperson in the laptop diagnostics, no duplicate audio).
10. Toggle airplane mode on the phone for ~10 s and back: both sides should
    reconnect (signaling retries with backoff) without a stale "connected" state.
11. On the laptop, watch **AI copilot status** (and the header chip). It must
    only say **AI connected** while the phone reports a live session, and the
    **Customer voice reaches the AI** row must say `yes` while the customer is
    speaking unmuted.
12. Force an AI drop (turn Wi-Fi/mobile data off on the phone for ~30 s, or wait
    for the provider call to end): the laptop must switch to **Reconnecting AI**
    or **AI error** with a safe explanation, while **Audio flowing** / peer
    bytes stay healthy. It must never show **AI connected** during the outage.
13. When connectivity returns, the customer device should create a new Ultravox
    call automatically (at most 3 attempts). If the panel ends at **AI error**
    with "recovery stopped", press **Restart AI** on the laptop: the customer
    device must create a fresh call and the status must move through
    Creating → Connecting → Connected. Audio must not drop.
14. Rotate the invitation from the laptop and join from a new browser/device.
    The new customer must get its own AI session (a new call id in the laptop
    diagnostics), not the previous dead one.
