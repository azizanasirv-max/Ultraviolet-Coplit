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
  rejected).
* A joining/reconnecting peer triggers `peer_joined`, which forces the
  salesperson to build a fresh connection and send a new offer. Presence
  refreshes (`session_state`) do not churn an established connection.
* The local microphone track is added to the connection once. ICE candidates are
  queued until the remote description exists. Duplicate offers are ignored using
  the ICE ufrag/pwd pair.
* `pc.connectionState === "failed"` triggers an ICE restart (with TURN this
  moves traffic to the relay). Microphone `mute`/`ended` events (mobile browsers
  can end a track when a second capture starts) trigger reacquisition and
  `replaceTrack`.
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
* TURN modes: coturn `TURN_SECRET` (short-lived HMAC credentials, preferred),
  static `TURN_USERNAME`/`TURN_CREDENTIAL`, or a managed provider's credentials
  API (`TURN_CREDENTIALS_URL`, GET or POST+`{ttl}`) fetched and cached server-side.
  Credentials are never logged and never appear in `/api/health`.
* `ICE_TRANSPORT_POLICY=relay` without a usable relay is a hard failure: the ICE
  endpoint returns 503 `TURN_MISCONFIGURED`, the engine refuses to create a peer
  connection or capture the microphone, and the dashboard shows the reason.
  There is no silent STUN-only fallback.
* Without TURN, carrier-NAT/mobile-data pairs still cannot connect; diagnostics
  show `relay candidates 0`, `selected pair host→srflx` and the amber TURN banner.

### The three communication paths

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

## 4. Diagnostics

Both dashboards show a details panel with:

* role, participant id, session id and session expiry
* WebSocket state and reconnect attempt counter
* peer-connection, ICE connection and ICE gathering state
* selected local/remote candidate types, relay flag, gathered candidate counts
* microphone permission, track state (including `disabled`), sender count
* remote track state, RTP bytes sent/received and kbps, `<audio>` paused/muted state
* autoplay error text
* AI status and AI error
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
| `npm run test:unit` | `SessionStore`: session/credential isolation, role mismatch, single-use invitation, rotation/revocation, expiry, resume identity, duplicate prevention, no plaintext secrets | 11/11 pass |
| `npm run test:turn` | ICE/TURN unit tests (synthetic env + mocked provider HTTP): URL parsing, static/ephemeral/provider credentials, HMAC correctness, relay-only fail-fast, provider caching/failure, no secret leakage | 17/17 pass |
| `npm run test:signaling` | Real HTTP + WebSocket server: join authentication, role enforcement, offer/answer/ICE relay, AI text relay to the salesperson only, cross-session isolation, reconnect identity, `peer_left`, invalid JSON, diagnostics authorization, customer-only Ultravox call, authenticated ICE endpoint, TURN static/ephemeral/provider delivery, relay misconfiguration, APP_URL, AI readiness without a key, secrecy | 25/25 pass |
| `npm run test:browser` | Chromium, two isolated browser contexts, synthetic media: role-specific UIs, invitation scoping/replay rejection, legacy URL rejection, bidirectional RTP, `<audio>` playing, mute/unmute on both sides, reconnect without duplicate participants/tracks, AI text on the correct dashboard, AI failure isolated, server-side client diagnostics, TURN applied to every PC (incl. reconnect), relay-only policy applied, relay-only-without-TURN refuses to start, no credential leakage in DOM/snapshot | 19/19 pass |
| `npm run build` | Production Vite build | pass |
| `npm run lint` | `tsc --noEmit` | pass |

### What synthetic tests do NOT prove

Chromium's fake audio device proves that signaling, negotiation, track routing,
RTP flow and element playback work. It does **not** prove acoustic quality,
speaker/microphone behaviour, echo, Bluetooth routing, iOS autoplay, or
connectivity across carrier NATs. Those require the two-device plan below.

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

### Deployment causes (separate from the audio bug)

* `vite: not found` happened because the repository had no `package-lock.json`,
  so Render never installed dependencies before running the build.
* `ERESOLVE` came from an unused direct `esbuild@^0.25` devDependency conflicting
  with Vite 8's optional peer `esbuild@^0.27 || ^0.28`.
* `tsx` (required by `npm start`) lived in devDependencies, so a production
  install could not start the server.

See [deployment.md](./deployment.md) for the exact fix and Render settings.

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
* Static TURN credentials, when used instead of `TURN_SECRET`, are delivered to
  every authorized browser and cannot be rotated per session.
* Managed-provider response shapes are covered by mocks; no live vendor API was
  exercised (that requires an account and credentials).
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
