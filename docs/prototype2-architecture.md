# Prototype 2 — salesperson-assisted AI conversation

This document describes the architecture as implemented in this branch, the
root cause of the broken human-to-human audio, the authorization model, the
three media paths, the tests that were actually executed, and the remaining
limitations.

## 1. Routes and participant interfaces

| Route | Who | Component | Renders |
| --- | --- | --- | --- |
| `/` and `/sales` | Salesperson / operator | `src/App.tsx` + `src/components/prototype2/SalespersonDashboard.tsx` | Salesperson dashboard plus the **Admin Settings** panel (first-run admin setup and ExpressTURN credentials) |
| `/join?invite=<token>` | Customer | `src/components/prototype2/CustomerDashboard.tsx` | Invitation redemption, join/leave, mic + speaker controls, connection status, salesperson captions |

The customer route never renders the salesperson dashboard, the app chrome,
AI status or error text, "AI heard"/listening indicators, AI suggestion
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
  entered by the operator in the app's **Admin Settings** panel (or at
  `/admin/turn`) and held only in server memory. The operator creates the setup
  password in the browser on first use (stored as a salted scrypt hash, never as
  plaintext and never in an environment variable); later changes require that
  password, a signed `HttpOnly`/`SameSite=Strict` session cookie and a
  per-session CSRF token.
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
6. **Packets are not sound.** `getStats()` counters only prove that RTP is
   arriving. A muted/disabled microphone, a track held by a second capture on the
   same device, or a track paused by the OS keeps producing RTP *frames of
   silence*. The engine therefore decodes the inbound track through a read-only
   `AnalyserNode` (never connected to a destination, so it cannot create feedback
   or a second playback path) and exposes `diagnostics.inboundAudioLevel` (RMS),
   `diagnostics.lastSoundAgoMs` and `snapshot.inboundSoundDetected`. The
   salesperson UI is driven by these measurements, not by `connectionState`.
7. **Playback is supervised.** `element.play()` is a single code path with a
   per-attempt token (a stale promise can never overwrite newer state).
   `NotAllowedError` marks playback as blocked; `AbortError` (interrupted by a
   newer attach) is not treated as a failure. A paused element with a live
   stream is retried at most every 5 s and again on any user gesture, so an
   autoplay rejection cannot leave a connected call inaudible.
8. **One remote stream, one playback path.** All inbound audio tracks are adopted
   into a single `MediaStream` that lives for the call, so a replaced track (ICE
   restart, renegotiation) never reloads the `<audio>` element, never re-triggers
   the autoplay policy and can never play twice. A track that `ontrack` never
   delivered is recovered from `pc.getReceivers()`. Replacing the element (a view
   switch or remount) detaches the old one first.
9. **The negotiated direction is verified.** `replaceTrack()` on a transceiver
   whose negotiated direction is `recvonly` publishes nothing, and every counter
   still looks healthy. After `answer` / connectivity the engine reads
   `transceiver.currentDirection`; if it cannot send with a live microphone (or
   cannot receive) it performs at most two bounded renegotiations. The customer
   (the answerer) asks the salesperson with the role-checked `renegotiate`
   signaling message; the salesperson creates a plain offer (not an ICE restart).

### Verified audio-quality guarantees (Task 2)

Task 1 made the inbound path measurable and supervised. Task 2 removed the
sources of noise, echo, repeated audio and unnecessary recovery that the
measurements exposed. Each guarantee below is backed by a deterministic test
(`tests/negotiation.test.ts`, `tests/aiSession.test.ts`,
`tests/microphone.test.ts`) or by real Chromium plumbing
(`tests/browser-audio.test.ts`).

10. **Exactly one playback path.** `ontrack` is idempotent: a repeated event for
    the track already adopted returns immediately, so it cannot rebuild the
    analyser graph (which used to reset the measured sound clock) or restart
    `play()`. The element is detached (`srcObject = null`, paused, `load()`) when
    the peer connection closes and when the call stops, so a reconnect can never
    leave a second element holding a dead stream. A detached/remounted element is
    only re-attached to the *same* stable stream.
11. **The microphone is opened once, and only when it is broken.** Recovery is
    single-flight, bounded (2 attempts per incident), and idempotent: a capture
    that is still `live`, unmuted and enabled is never replaced. All three
    recovery paths (`mute` timer, `ended` event, periodic supervisor) share that
    budget, and a dead capture is stopped *before* the replacement is opened, so
    two captures of one device never overlap. Track listeners are stored and
    removed, and the capture is released on stop.
12. **One documented capture policy, measured not assumed.** `src/lib/microphone.ts`
    requests echo cancellation and noise suppression (`ideal`, never `exact`),
    mono capture and **no automatic gain control**. `track.getSettings()` is read
    back and turned into a diagnostics summary (`aec on · ns on · agc off · 1ch ·
    48000 Hz`) plus warnings when the browser dropped a stage — a call can no
    longer look healthy while echo cancellation is silently inactive.
13. **The agent never plays audio on the customer device.** The Ultravox speaker is
    muted *before* the room is joined and the output medium is text, because
    `ultravox-client` enables a subscribed agent-audio publication unless its
    speaker-mute flag is already set. Agent audio leaking into the customer's
    speakers was doubled with the salesperson's voice and was picked up by both
    of that device's microphone captures (the AI hearing itself → repeated
    words).
14. **Recovery does not touch a healthy capture.** A playback recovery, a
    reconnect, a renegotiation or a React remount never restarts microphone
    capture; `diagnostics.micCaptures` proves it stays at 1 for a whole call.

## 4. Diagnostics

Both dashboards show a details panel with:

* role, participant id, session id and session expiry
* WebSocket state and reconnect attempt counter
* peer-connection, ICE connection and ICE gathering state
* selected local/remote candidate types, relay flag, gathered candidate counts
* microphone permission, track state (including `disabled`), sender count
* remote track state, RTP bytes sent/received and kbps, `<audio>` paused/muted state
* inbound RTP packets, packets lost and jitter (proof that RTP arrives)
* measured inbound audio level in RMS and dBFS, and how long ago sound was heard
  (proof that the remote microphone carries sound)
* measured microphone level of this browser (proof that its own capture is live)
* the processing the browser actually applied to the capture
  (`diagnostics.microphoneProcessing`, e.g. `aec on · ns on · agc off · 1ch ·
  48000 Hz`, plus `echoCancellationActive`) and how many times the microphone was
  opened (`diagnostics.micCaptures`). Both are salesperson-panel/log only; no
  customer sees them.
* playback state (`playing` / `paused` / `blocked` / `no_track`) and the playback
  error text
* negotiated audio direction (`sendrecv` / `sendonly` / `recvonly` / `inactive`)
* autoplay error text
* per-participant `client_diagnostics` (mic level, inbound level, packets,
  playback, direction) of the other device, so a silent or muted remote
  microphone is visible from the salesperson dashboard
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
| `npm run test:signaling` | Real HTTP + WebSocket server: join authentication, role enforcement, offer/answer/ICE relay including the customer's role-checked `ice_restart` request and role-checked `renegotiate` request, AI text relay to the salesperson only, cross-session isolation, reconnect identity, `peer_left`, invalid JSON, diagnostics authorization, customer-only Ultravox call, **AI call rotation, failed-creation retry, AI status relay/role enforcement/redaction, customer-disconnect AI state**, authenticated ICE endpoint, TURN static/ephemeral/provider delivery, relay misconfiguration, APP_URL, AI readiness without a key, secrecy | 35/35 pass |
| `npm run test:negotiation` | Deterministic fake WebRTC/WebSocket: repeated `session_state` never creates a duplicate offer, no offer while `have-local-offer`, queued ICE restart runs when stable, an unanswered offer is rolled back and retried within a bounded budget, signaling-send/createOffer/setLocalDescription failures each consume one bounded attempt, bounded recovery reaches terminal with no busy loop, a later attempt within budget can recover, watchdog never rolls back an in-flight answer, a failed answer re-arms the watchdog, stale-peer answers cannot cancel a new watchdog, signaling rejoin after terminal starts a fresh negotiation, duplicate failure events coalesce, no PC churn after terminal, replacement cancels timers/ignores stale callbacks, customer restart request path, transient disconnect, AI independence, **late microphone attaches through a sendrecv transceiver + replaceTrack with one sender**, **microphone recovery stops the stale capture**, **a connected call with no inbound RTP recovers through a forced bounded ICE restart and then fails honestly**, **real inbound RTP never causes an ICE restart**, **inbound audio is only reported as working when sound is measurable (RMS), silence is reported as silence**, **blocked/aborted/supervised playback**, **a replaced remote track reuses one stream and one playback path**, **a receiver track is adopted when `ontrack` never fires**, **an ended track is reported and a replacement restores audio**, **the customer requests a renegotiation when the negotiated direction cannot carry its microphone (bounded)**, **the salesperson renegotiates a `sendonly` (one-way) negotiation but never a healthy `sendrecv` one**, **an outbound capture that ended without an event is re-acquired**, **the salesperson never creates an Ultravox session**, **a repeated `ontrack` keeps one playback path/analyser and does not reset the measured sound state**, **a remounted `<audio>` element leaves exactly one playback path**, **a reconnect detaches the old playback path before the new stream exists**, **stopping the call releases the capture, its listeners, the analysers, the timers and playback**, **quiet speech is measured and never gated**, **each participant publishes its own microphone and plays only the remote track**, **a healthy capture is never reopened and a dead one is replaced without overlap**, **microphone recovery is bounded and cannot reopen the device in a loop**, **recovery removes the replaced capture's listeners** | 47/47 pass |
| `npm run test:ai` | **Mocked `UltravoxSession` + mocked `fetch`**: new-call-per-retry, connected only from live SDK status, mic-published reporting, abnormal-close recovery, stale-callback isolation, bounded retries with real error text, duplicate-retry suppression, salesperson restart over signaling, AI failure leaves WebRTC state untouched, **the agent speaker is already muted and the output is text-only before the room is joined** | 9/9 pass |
| `npm run test:audio` | Pure inbound-audio state machine: a fully measured call is the only "working audio" state; connected-without-packets, packets-without-sound, blocked/paused playback, locally muted speaker, absent customer and pending transport are all distinguished; level formatting | 8/8 pass |
| `npm run test:microphone` | Pure capture policy: exact requested constraints (AEC/NS on, AGC off, mono, `ideal` never `exact`, no gate/threshold keys), applied-settings parsing where "not reported" is not "off", the measured summary, warnings when the browser dropped AEC/NS/AGC/mono, and the publishable-capture rule that keeps a deliberately muted capture from being re-acquired | 7/7 pass |
| `npm run test:browser` | Chromium, two isolated browser contexts, synthetic media: role-specific UIs, invitation scoping/replay rejection, legacy URL rejection, bidirectional RTP, `<audio>` playing, mute/unmute on both sides, reconnect without duplicate participants/tracks, **presence-refresh flood smoke test (real Chromium; the deterministic suite is the D1 regression proof)**, AI text on the correct dashboard, AI failure isolated **and visible on the salesperson dashboard**, **salesperson-triggered AI restart without dropping audio**, **rotated invitation creates a new AI call**, server-side client diagnostics, TURN applied to every PC (incl. reconnect), relay-only policy applied, relay-only-without-TURN refuses to start, no credential leakage in DOM/snapshot, **two browser instances with different microphone tones (440 Hz / 1200 Hz) prove non-silent decoded audio in each direction independently with matching inbound RTP bytes/packets/audioLevel**, **the salesperson's measured inbound level/dBFS and `playbackState` prove audible, playing audio (not just RTP) and the `sendrecv` direction**, **a live-but-silent customer microphone produces `inboundSoundDetected: false`, a visible actionable warning and a headline that does not claim working audio**, **a paused remote audio element is resumed by playback supervision with one stream and one peer connection**, **an interrupted customer capture is re-acquired and audio returns with exactly one live capture and no duplicate playback**, **the AI capture is a separate capture and an AI failure never interrupts participant audio**, **reconnect leaves exactly one live, enabled capture and audio still flowing**, **the customer DOM shows no RTP/ICE/TURN error or AI internals**, **each direction has exactly one playback path and one capture (`diagnostics.micCaptures === 1`, only one element ever plays a stream)**, **switching views while live neither remounts a second element nor reopens the mic**, **a reconnect leaves `micCaptures === 1` and one playback path per side**, **leaving the call releases the capture and the playback path** | 39/39 pass |
| `npm run build` | Production Vite build | pass |
| `npm run lint` | `tsc --noEmit` | pass |

Task 2 totals: `npm test` = 183/183 assertions across 11 suites; `npm run test:browser`
= 39/39 in real Chromium (two browser instances, synthetic 440/1200 Hz tones and a
silent WAV).

### What synthetic tests do NOT prove

Chromium's fake audio device proves that signaling, negotiation, track routing,
RTP flow, decoded remote audio energy and element playback work. The tone test
decodes the received stream and requires the *other* participant's frequency in
each direction, so a duplicated or silent stream fails. It does **not** prove
acoustic quality, speaker/microphone behaviour, echo, Bluetooth routing, iOS
autoplay, or connectivity across carrier NATs — everything ran on one host with
host candidates and no relay. Those require the two-device plan below and a
configured TURN relay.

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

### Customer -> salesperson audio: what was still wrong (this change)

The reported symptom — the customer is heard by the AI, the salesperson is heard
by the customer, but the salesperson hears nothing while the UI looks healthy —
cannot be explained by the transport: an ICE/DTLS connection carries media in
both directions, and the same connection already delivers the salesperson's
audio. Three defects in the *inbound* half of the path produced it, and none of
them is visible to `connectionState` or to RTP counters:

1. **"Audio flowing" was derived from RTP byte counters only.** A microphone
   track that is muted, disabled, held by a second capture on the same device, or
   ended by the OS keeps the sender transmitting RTP *frames of silence*.
   `getStats()` therefore kept increasing, the media watchdog was satisfied, and
   the salesperson dashboard reported working audio for a silent stream. This is
   exactly the "connected but nothing audible" state.
2. **Playback was not supervised.** The remote stream was attached by replacing
   `srcObject` on a hidden `<audio>` element, which reloads the element and
   re-runs the autoplay policy. A rejected `play()` was recorded once and never
   retried, and an element that ended up paused (a reload, a remount, a view
   switch) was never detected at all: the call stayed "connected" and inaudible.
   A React remount also left the *old* element holding the stream.
3. **The outbound capture was trusted to emit events.** The customer's published
   track could end (or be handed to another capture) without an `ended`/`mute`
   event, and the negotiated audio direction was never verified: `replaceTrack()`
   into a `recvonly` transceiver publishes nothing while everything else looks
   fine.

Each is fixed by measurement rather than assumption (see the nine guarantees in
section 3) and by the diagnostics/UI described in section 4. What this change
does **not** do is remove the duplicate microphone capture on the customer
device: `ultravox-client@0.6` has no public API for adopting an existing track,
and merging the two paths would make participant audio depend on the AI session,
which requirement 5 of this work forbids. The duplicate capture is now *visible*
(customer mic level vs. inbound level) instead of silent.

### Audio noise, echo and repeated audio: what this change fixes (Task 2)

The follow-up report was different from Task 1's: audio was audible, but it was
noisy in the pauses, sometimes echoed or sounded doubled, words were repeated,
and calls dropped or degraded for no visible reason. These symptoms have
*separate* causes; only some of them live in this codebase.

**Confirmed defects (code evidence), and what was done:**

1. **The agent's voice could play on the customer's speakers.**
   `ultravox-client` attaches a subscribed agent-audio track to its own
   `Audio()` element and only disables the publication when its speaker-mute flag
   is already set (`node_modules/ultravox-client/dist/esm/index.js`,
   `TrackSubscribed` → `setEnabled(!isSpeakerMuted)`). The engine muted the
   speaker in the *status* handler for `LISTENING`/`IDLE` — i.e. after the first
   agent utterance had already been rendered. That audio was (a) played on top of
   the salesperson's voice ("doubled") and (b) picked up by both of the customer
   device's microphone captures, so the AI heard itself → repeated words.
   *Fix:* `muteSpeaker()` + `setOutputMedium(Medium.TEXT)` before `joinCall()`,
   re-applied on live status. Test: `tests/aiSession.test.ts` asserts the speaker
   is already muted at join time.
2. **Recovery was unbounded and could reopen the microphone forever.**
   Only the periodic supervisor incremented the mic-recovery counter; the `mute`
   timer and the `ended` handler called `recoverLocalTrack()` without any budget,
   and `recoverLocalTrack()` called `ensureLocalStream(true)` unconditionally
   (even for a healthy capture) and opened the new capture *before* stopping the
   dead one. A device that mutes every new track (mobile, or a second capture
   holding the device) therefore produced an endless sequence of opens: clicks
   and pops, level jumps, two overlapping processing pipelines, and a degraded
   AI capture. *Fix:* one shared budget, single-flight, an idempotent
   healthy-capture check, and "stop the dead capture first". Tests:
   `bounded and never reopens the device in a loop`, `a healthy capture is never
   reopened…`, `recovery cleans up the listeners…`.
3. **The playback path was never detached.** `closePeerConnection()` and
   `stop()` dropped the engine's reference to the remote stream but left
   `element.srcObject` (and the primed silent blob) in place; a repeated
   `ontrack` rebuilt the inbound analyser, which reset the measured
   "sound was heard" clock and restarted `play()`. *Fix:* `detachPlayback()`,
   idempotent adoption, `releaseSilentClip()`. Tests: `a repeated ontrack…keeps
   one playback path`, `a remounted audio element leaves exactly one playback
   path`, `a reconnect detaches the old playback path…`,
   `stopping the call releases the capture…`.
4. **Microphone processing was requested blindly.** Three hard-coded `true`
   flags, nothing ever read `track.getSettings()`, so a browser that silently
   dropped echo cancellation produced echo while every counter looked healthy.
   *Fix:* `src/lib/microphone.ts` (one documented policy, `ideal` constraints,
   applied-state report + warnings) and `diagnostics.microphoneProcessing` /
   `echoCancellationActive`. Tests: `tests/microphone.test.ts`.

**Investigated, no code defect found (do NOT "fix" these by guesswork):**

* *Duplicated transcript data in the SDK.* `session.transcripts` is a
  per-`ordinal` accumulator in the SDK (`addOrUpdateTranscript` replaces, it
  never appends a second copy). **Correction (Task 3):** the array is deduped,
  but the SDK re-emits the *whole array* on every update and the engine
  forwarded every entry each time. Earlier final segments were therefore re-sent
  over signaling whenever a later partial arrived. Repeated *words* were not
  caused by duplicated events; the only evidence-backed repetition path was the
  agent hearing its own audio (defect 1). Task 3 fixes the re-send and the
  salesperson-side ordering/dedup.
* *Double audio processing inside this app.* The engine's `AudioContext` is used
  only for read-only `AnalyserNode`s and is never connected to a destination, so
  it cannot add a playback path, a gain stage or a feedback loop.
* *Two microphone captures on the customer device.* `ultravox-client@0.6` has no
  public API for adopting an external track (`createLocalAudioTrack()` is called
  internally), and merging the two paths would couple participant audio to the AI
  session. This is unchanged and remains the most likely source of device-level
  (not code-level) artefacts on mobile; it is now visible as
  `diagnostics.micCaptures` (1 for the engine) and by measuring the AI capture
  separately in the browser suite.

**Automatic gain control: evaluated, requested off.** AGC was `true` (the
Chromium default). It is a *moving* gain stage: it lifts the noise floor while
nobody speaks (the classic "hiss/crackle in the pauses") and changes the level of
the same voice between phrases ("pumping", "inconsistent"). The policy now
requests `autoGainControl: { ideal: false }` **for the human path only**: the
Ultravox/LiveKit capture keeps its own AGC, so transcription keeps the level it
needs. Trade-off, stated honestly: a genuinely low-gain device now stays quieter
instead of being pumped up, which is why the measured level is in diagnostics.
This is a *mitigation based on the reported symptoms*, not a proven root cause;
real-device listening is still required (see the two-device plan) and the whole
policy is one constant in `src/lib/microphone.ts`.

## 6b. Customer transcription quality and multilingual handling (Task 3)

### Pipeline that was audited

```
customer microphone
  -> participant WebRTC (salesperson hears it)                     [unchanged]
  -> Ultravox SDK local mic capture -> Ultravox ASR
  -> SDK "transcripts" event (one sparse array indexed by ordinal)
  -> CallEngine listener
       agent  -> `ai_suggestion`  (salesperson only)
       user   -> `customer_speech_transcript` (salesperson only)
  -> server role check + relay (customer is the only allowed sender)
  -> salesperson CallEngine -> SalespersonDashboard
```

The salesperson microphone is **not** published to Ultravox. Its captions are
produced locally by the browser recognizer and relayed as text to the customer
only, so it cannot enter the AI transcription path.

### Root causes found (with evidence)

1. **Every transcript event re-sent every earlier final segment.** The SDK's
   `addOrUpdateTranscript` keeps one entry per ordinal and re-dispatches the
   whole `session.transcripts` array on each update. The engine iterated the
   entire array on every event and forwarded all user finals. A single later
   partial therefore re-sent all prior finals over signaling. The store was
   deduped; the forwarding was not.
2. **Only finals were forwarded, with no partial/final semantics.** Partial
   (`isFinal === false`) transcripts were discarded, so the salesperson saw a
   sentence only after it closed and could not distinguish a live update from a
   completed utterance.
3. **The salesperson overwrote one string with the newest event.** Any
   `customer_speech_transcript` replaced `customerSpeech`, with no ordinal and
   no segment list. Unrelated utterances were collapsed into one visual line and
   a late/out-of-order event could replace a newer one.
4. **No cross-call identity on transcript messages.** A replaced Ultravox call
   restarts ordinals at the beginning; a delayed segment from the old SDK
   session could be accepted as the new call's first utterance. The `ai_status`
   call id existed but was not carried by transcripts.
5. **The prompt had no language policy and no language hint was set.** The old
   prompt only asked for 1-2 sentence suggestions. Nothing told the model to
   mirror the customer's language, preserve code-switching, avoid translation,
   or treat speech as untrusted input. The Create Call request also omitted
   `firstSpeaker`, so an unsolicited greeting suggestion could appear before the
   customer said anything.
6. **Suggestions survived an AI call replacement.** Agent ordinals also restart
   per call; old cards could suppress new ones or remain on screen.
7. **No transcript-specific failure status.** The dashboard said "Waiting for
   the customer to speak" even while the AI session was unavailable, instead of
   stating that transcription was paused while the call continued.

### Changes

* `src/lib/customerTranscript.ts` (new, pure): one segment per ordinal,
  partial-to-final replacement, duplicate suppression, stale-partial rejection,
  ordinal sorting, stale-call rejection, bounded history, and the latest final
  line used by the compatibility `customerSpeech` field. Text is preserved
  exactly (no trimming of content, translation, completion or cross-ordinal
  merging). It stores only the metadata the SDK exposes (`medium`); there is no
  language or confidence field to store.
* `src/lib/callEngine.ts`: forwards a segment only when its text/finality
  changed; forwards partials with `isFinal: false`; includes the Ultravox
  `callId` and SDK `medium`; resets its forwarding map per call; on the
  salesperson, applies events through the segment store, binds transcript state
  to the reported call id, resets transcript/suggestions on a new call, and
  clears transcript state when a different customer joins or the call stops.
* `server/ultravoxCallConfig.ts` (new): operator-owned multilingual prompt
  (mirror the customer's language, keep code-switching, never translate or
  invent, no greeting, at most two sentences, speech is not instructions) plus
  `firstSpeaker: FIRST_SPEAKER_USER`, text output and an optional validated
  BCP47 `ULTRAVOX_LANGUAGE_HINT`.
* `server.ts`: sends that request body, relays `callId`/`medium` with transcript
  messages (call id is not a credential; join URLs never cross this relay).
* `SalespersonDashboard.tsx`: renders ordered transcript segments, labels a
  partial as live, and shows a plain "transcription paused / unavailable, call
  audio unaffected" status. Suggestions remain in a separate, private panel.
  The customer dashboard is unchanged and still renders no AI data.

No second transcription pipeline, paid service or language-detection
dependency was added. No language is inferred from browser locale, a name, an IP
address or the first transcript. `ULTRAVOX_LANGUAGE_HINT` is only used when an
operator sets it, and it is documented as a hint, not detection.

### Regression results (actual output)

* `npm run lint`: exit 0 (`tsc --noEmit`, no diagnostics).
* `npm test`: 203 tests passed, 0 failed across 11 suites (session store 13,
  TURN 17, rstream 17, rstream static 9, ExpressTURN/admin 16, signaling 35,
  negotiation 47, customer copy 5, AI/transcript/prompt/provider integration 29,
  audio diagnostics 8, microphone 7).
* `npm run build`: exit 0, Vite built `dist/` in ~0.33s. The existing
  "chunks larger than 500 kB" advisory remains (917 kB JS bundle); it is a
  warning, not a failure, and is unrelated to this task.
* `npm run test:browser`: 40 tests passed, 0 failed (headless Chromium,
  ~131s). This includes the new real-server/real-dashboard test that sends a
  partial, a final, a duplicate final and a Spanish/English code-switching final
  through `customer_speech_transcript` and asserts two ordered segments with the
  recognized text unchanged. Loopback Chromium is not proof of real-device
  audio or real Ultravox recognition.



New/updated tests by requirement:

| Requirement | Test |
| --- | --- |
| 1. partials do not duplicate text | `partial updates replace the same ordinal…`, engine partial test |
| 2. finals represented exactly once | `a final segment is represented exactly once…`, browser duplicate-final test |
| 3. repeated words intact | `legitimate repeated words are preserved verbatim`, engine byte-for-byte test |
| 4. out-of-order / stale / duplicate | `out-of-order, duplicate and stale partial events…`, salesperson view test |
| 5. reconnects cannot mix sessions | `a new Ultravox call cannot inherit…`, engine reconnect test, salesperson `ai_status` reset |
| 6. mixed-language preserved | `mixed-language and code-switching speech is preserved exactly` |
| 7. AI language instructions | `tests/aiPrompt.test.ts`, `tests/ultravoxCall.test.ts` |
| 8. AI failure does not end the call | engine failure test, existing `an AI disconnect…` test |
| 9. customer UI privacy | existing browser role-interface test + signaling privacy test |
| 10. existing suites green | full `npm test` / `npm run test:browser` output above |

### Remaining language / SDK limitations

* `ultravox-client@0.6` `Transcript` exposes only `text`, `isFinal`, `speaker`,
  `medium` and `ordinal`. There is **no language or confidence metadata**, so
  the UI cannot show them honestly.
* `languageHint` is a BCP47 hint on the Create Call API, fixed for the whole
  call; it is not per-utterance detection and cannot follow a mid-call language
  switch. That is why it is opt-in rather than inferred.
* The prompt asks the model to mirror the customer's language but cannot
  guarantee it, and a passing unit test only proves the instruction was sent.
* Recognition accuracy, accent handling and mixed-language quality were **not**
  measured here. That needs representative recorded speech and real API calls
  (see §9), not unit tests.


## 7. Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `ULTRAVOX_API_KEY` | yes | Server-side Ultravox call creation. Never sent to clients. |
| `ULTRAVOX_LANGUAGE_HINT` | optional | BCP47 hint for recognition/synthesis (for example `es-MX`). Not detection; fixed per call. Omit for code-switching customers. Invalid values are ignored. |
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
* **Noise, crackle, echo and perceived loudness were NOT measured on physical
  devices.** The automated tests prove *plumbing* (one playback path, one
  capture, bounded recovery, no agent audio on the customer device, level
  measurement). They cannot prove that a real microphone/speaker pair is free of
  acoustic artefacts: Chromium's fake device has no room, no speaker and no ADC.
  Turning AGC off in particular changes the perceived level and MUST be listened
  to on the two-device plan below (one constant in `src/lib/microphone.ts`).
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
15. **Audio quality (Task 2) on real devices.** With both participants on the
    same physical room and no headphones, confirm there is no echo or doubled
    voice, and that no tapping/crackling is audible while both sides are silent
    (listen for 20 s). Then compare with headphones and with the phone's speaker
    at maximum volume: if the artefacts only appear on speakers, the acoustic
    path (room + device) is the cause, not the app.
16. In the laptop diagnostics, confirm `mic processing` shows `aec on · ns on ·
    agc off` and that `mic captures` stays at **1** for the whole call — including
    after a reconnect, a view switch and a forced microphone interruption
    (unplug/replug a headset on the customer device). A value above 1 after a
    single incident means recovery ran more than once.
17. If the customer's voice is judged too quiet with `agc off`, set
    `PARTICIPANT_MICROPHONE_POLICY.autoGainControl = true` in
    `src/lib/microphone.ts`, rebuild, and compare. Record which setting was
    better on the real device; that is the only measurement that can settle it.
18. Confirm the customer device never plays the AI agent's voice: the agent is
    text-only (`mic processing`/logs aside, no agent audio should be audible on
    the phone). If agent audio is heard, the speaker mute before `joinCall()` is
    not reaching the SDK and must be reported.
