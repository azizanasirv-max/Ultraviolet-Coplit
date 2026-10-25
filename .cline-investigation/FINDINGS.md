# WebRTC direct-connectivity investigation — Ultraviolet Coplit

Investigation date: 2026-10-25
Repository: https://github.com/azizanasirv-max/Ultraviolet-Coplit
Branch inspected: `main` @ `d856e88334e4d5ac4e53a40e60a06cea221a1651`
(working branch for this investigation: `cline/5nngr78p`, no app code changed)

## 0. Verdict (short)

Direct peer-to-peer audio **does work** when both peers share a usable direct path:
with TURN absent, Chromium gathered **host** and **server-reflexive (srflx)**
candidates, ICE/DTLS reached `connected`, the selected pair was `host → host`,
and real Opus RTP flowed in **both** directions with audible energy.

However, three implementation defects were confirmed with real browser/ICE
measurements, and one is serious on real networks:

1. A presence-refresh renegotiation leaves the **salesperson in
   `signalingState = "have-local-offer"` indefinitely** (until the whole peer
   connection is recreated) even though audio is flowing, because
   the customer classifies the second offer as a duplicate and never answers.
2. When ICE later fails, the automatic **ICE restart is silently skipped**
   because of that stuck signaling state. No retry/backoff exists.
3. On an unreachable direct path, every server presence update **tears down and
   recreates the RTCPeerConnection**, producing 4 peer connections in 56 s,
   restarting ICE each time; after 56 s the UI still reported "connecting" with
   no error while the cycle continued.

Loopback success is **not** evidence of universal direct connectivity. A
constrained-NAT simulation (public-interface-only host candidates, symmetric
mapping on one public IP) never connected. Mobile-carrier NAT, symmetric NAT and
UDP-blocking firewalls cannot be reproduced in this sandbox.

## 1. Deployed implementation (main branch)

| Concern | Implementation |
| --- | --- |
| Media engine | `src/lib/callEngine.ts` — one `RTCPeerConnection` per participant |
| Signaling | App WebSocket `/ws`; server relay in `server.ts` (`offer`, `answer`, `ice_candidate`) |
| Roles | Salesperson is always offerer, customer always answerer (`makeOffer` refuses non-salesperson) |
| SDP | Trickle ICE; one BUNDLE audio m-line; `max-bundle`, `rtcpMuxPolicy: require` |
| ICE config | `GET /api/sessions/:id/ice-config` (session-credential auth) → `server/turn.ts` |
| STUN default | `stun.l.google.com:19302`, `stun1`, `stun2` (`server/turn.ts` `DEFAULT_STUN_URLS`) |
| TURN | Env-driven only (`TURN_URLS` + secret/static/provider). `render.yaml` marks all TURN keys `sync: false`; docs state no relay is configured in the repo |
| Relay-only | `ICE_TRANSPORT_POLICY=relay` fails closed with HTTP 503 `TURN_MISCONFIGURED` |
| Candidate buffering | `callEngine.flushPendingIceCandidates()` after every `setRemoteDescription` |
| ICE restart | `attemptIceRestart()` → `createOffer({ iceRestart: true })`, salesperson only |
| Diagnostics | `getStats()` loop exposes candidate types, selected pair, byte counters, DTLS state |

The live Render service could not be inspected. Two read-only probes of
`https://ultraviolet-copilot.onrender.com` returned **HTTP 522** first and then
**HTTP 404** with `x-render-routing: no-server` (Render reports no server for
that hostname). Render environment values are not in the repository. Therefore
whether the *deployed* instance has a TURN relay configured is **unverified**;
all findings below are from the main-branch code executed locally with real
Chromium. No deployment or Render setting was touched.

## 2. Method

- Production build (`npm run build`), server started with `serveFrontend: true`.
- Two **isolated Chromium browser contexts** (separate profiles), fake audio
  device + fake UI permission, autoplay allowed.
- `window.RTCPeerConnection` instrumented before app code to capture every PC,
  every signaling/ICE/connection/gathering state transition, every trickled
  candidate (type, protocol, address, port, related address), and `track` events.
- After connection: `getStats()` on both sides for local/remote candidates,
  candidate pairs, selected pair, transport (DTLS/ICE role), inbound and
  outbound audio byte/packet counters, audio energy, and `<audio>` element state.
- TURN control: a **real TURN server** (`node-turn` 0.0.6, RFC 5389/5766,
  long-term credentials) on `127.0.0.1:3478`, with `ICE_TRANSPORT_POLICY=relay`
  so media must traverse the relay.
- No application source, Render setting, or deployment was modified. The harness
  lives only in `.cline-investigation/`.

## 3. Test matrix and measured results

All runs: 2 contexts, one session, salesperson joined first, then customer.
`bytes` are final inbound/outbound **audio** RTP bytes from `getStats()` after ~10 s.

| # | Scenario | ICE servers / policy | PCs (S/C) | ICE / PC / DTLS | Selected pair | Audio bytes S (in/out) | Audio bytes C (in/out) | Media flowing |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | `direct` (TURN absent) | 3× Google STUN, `all` | 1 / 1 | connected / connected / connected | **host → host** | 22,827 / 22,827 | 22,904 / 22,904 | yes |
| B | `direct` host-only (no STUN servers at all) | none, `all` | 1 / 1 | connected / connected / connected | **host → host** | 22,598 / 22,706 | 22,706 / 22,598 | yes |
| C | `turn-all` (TURN available but not forced) | STUN + real TURN, `all` | 1 / 1 | connected / connected / connected | **host → host** (TURN unused) | 22,827 / 22,827 | 22,827 / 22,827 | yes |
| D | `turn-relay` (TURN control) | STUN + real TURN, `relay` | 1 / 1 | connected / connected / connected | **relay → relay** (127.0.0.1:50736 ↔ :53622) | 22,716 / 22,522 | 22,603 / 22,793 | yes |
| E | `turn-relay-fail` (relay process stopped after connect) | STUN + real TURN, `relay` | 1 / 1 | disconnected→**failed** / disconnected / connected | relay → relay (before stop) | 22,635 / 22,879 | — | no after failure |
| F | `direct` + `--force-webrtc-ip-handling-policy=default_public_interface_only` (no usable host candidates; one public IP) | 3× Google STUN, `all` | **4 / 4** | **never connected** (checking) | none | 0 / 0 | 0 / 0 | no |
| G | `direct` + offer delayed 600 ms (signaling reordering) | 3× Google STUN, `all` | 1 / 1 | connected / connected / connected | **host → host** | 22,621 / 22,991 | 22,991 / 22,621 | yes |
| H | `direct-relay` (relay forced, no TURN) | none, `relay` | 0 / 0 | no PC created | — | — | — | no (explicit 503) |

Sample growth (proves live RTP, not a single burst): scenario A salesperson
7,225 → 15,001 → 22,827 bytes over 5 s; customer mirrored. Inbound
`totalAudioEnergy` was 2.09 (A), 2.08 (B/G), 2.08 customer / 1.91 salesperson
on the TURN relay run — i.e. decoded non-silent audio on both ends. `<audio>` was `paused=false`, `muted=false`,
`srcObjectAudioTracks=1`, `mediaFlowing=true`.

Candidate facts (scenario A, salesperson): local `host/udp/240.112.23.39:51742`
plus `srflx/udp/34.67.51.12:2048` (related 240.112.23.39); local SDP carried
`host:1, srflx:1`; remote SDP carried `host:1`; the customer saw both host and
srflx remote candidates. With zero ICE servers (scenario B) only host candidates
were gathered and the call still connected — confirming host candidates do not
depend on STUN.

Scenario C shows a Chrome optimization worth noting: despite a valid TURN
server, `relayCandidates=0` and no relay allocation appeared while host
connectivity succeeded. TURN was available but not exercised.

## 4. Requirement-by-requirement findings

### 4.1 ICE uses host + srflx when TURN is absent — **verified**
Turn absent: `iceServers` contained only the three Google STUN entries. Gathering
produced `host` and `srflx` candidates (`iceGatheringState: complete`), both were
trickled and received by the peer, and ICE connected. When the host pair was
available it won (`host → host`); srflx was present but not selected, which is
expected ICE priority behavior. Host-only (no STUN at all) also connected.

### 4.2 SDP negotiation — **correct in the happy path**
One `m=audio ... UDP/TLS/RTP/SAVPF 111 63 9 0 8 13 110 126` line, BUNDLE,
`rtcp-mux`, DTLS `setup:actpass` (offer) → `active` (answer), one audio sender
per side. Salesperson offer → customer answer, no glare. Signaling state reached
`stable` in scenarios A/B/C/G.

### 4.3 ICE candidate exchange, buffering, remote-description ordering — **verified working**
Normal runs: candidates are trickled after `setLocalDescription`, added after
`setRemoteDescription` (no `addIceCandidate` errors in any log).

Reordering test (G): the offer was held 600 ms while candidates flowed. The
customer logged `Buffered ICE candidate (1 queued) … (2) … (3)` **before**
`Received offer`, then `setRemoteDescription` → flush → answer. The salesperson
buffered 1 candidate before the answer. The call connected and reached
`stable`. Buffering and “remote description before candidates” ordering are
implemented correctly.

Caveat: buffered entries are filtered only by `from` at flush time, not when
queued; candidates queued for an older peer remain until flush and produce
`addIceCandidate` warnings when applied to a new remote description. No failure
was observed from this.

### 4.4 Peer-connection lifecycle, duplicates, stale callbacks
- Normal path: exactly **1** `RTCPeerConnection` per page, 1 open, no duplicates,
  and `closePeerConnection` guards PC callbacks with a generation check.
- Unreachable path: **4** PCs in 56 s (scenario F) — see defect D3.
- Stale callbacks: `pc.onicecandidate`, `onconnectionstatechange`,
  `oniceconnectionstatechange`, `ontrack` are generation-guarded, but the
  per-track `onmute` / `onunmute` / `onended` handlers set `remoteTrackState`
  without any guard and are not cleared on close — see defect D4.

### 4.5 Audio-track handling — **verified for the normal path**
Mic is acquired before signaling opens, so each PC is created with exactly one
local audio track (`localSenderCount=1`, sender kind `audio`). Remote track
arrives (`track` event), `<audio>` gets a 1-track MediaStream, is not paused,
and RTP bytes/energy increase on both ends. Mute uses `track.enabled` (existing
tests). No missing-track failure occurred in these runs; an edge path with no
sender during recovery is noted as a latent risk (D7).


## 5. Confirmed implementation defects

### D1 — Duplicate presence-refresh offer leaves the offerer stuck in `have-local-offer` (HIGH)

**Where:** `src/lib/callEngine.ts:1446-1448` (`applyPeers` → `makeOffer` while
`pc.connectionState !== 'connected'`), `1296-1330` (`makeOffer`),
`1592-1598` (answerer duplicate-offer suppression).

**Mechanism:** the server pushes `session_state` whenever the customer reports AI
status (`server.ts:286-296`, triggered at `server.ts:1003`) and on joins. Each
push calls `applyPeers`; while the PC is `connecting`, the salesperson calls
`makeOffer({reason:'presence refresh: session_state'})`. This offer has the **same
ICE ufrag/pwd** as the first offer, so the customer logs
“Ignoring duplicate offer: ICE credentials match the active session” and sends
**no answer**. The salesperson's `setLocalDescription` already moved it to
`have-local-offer`. No answer for that offer ever arrives, so the state persists
until the entire peer connection is recreated.

**Measured evidence (scenario D, real TURN, relay-only):**
```
5:09:06 Salesperson: Offer sent [peer_joined].
5:09:06 Customer:    Received offer. Creating answer... / Answer sent.
5:09:06 Salesperson: Answer applied.
5:09:06 Salesperson: Offer sent [presence refresh: session_state].
5:09:06 Customer:    Ignoring duplicate offer: ICE credentials match the active session.
final: connectionState=connected, iceConnectionState=connected,
       signalingState=have-local-offer, inbound 22,716 B, outbound 22,522 B
```
Audio was flowing, but the **offerer's signaling state never returned to
`stable`** for the remaining 10 s of the call. Reproduced in 2/2 relay runs and in
the constrained-NAT run.

**Why it matters:** all later renegotiation is blocked (`makeOffer` refuses any
state but `stable`), including the ICE restart in D2, and mic-track
renegotiation. It also makes the call's signaling state inconsistent with a
healthy connection. This is not a network limitation; it is a deterministic
consequence of re-offering during connection setup.

### D2 — ICE restart is silently skipped and never retried (HIGH)

**Where:** `callEngine.ts:1256-1260` and `1263-1267` (both `failed` handlers call
`attemptIceRestart`), `1332-1336`, `1310-1313` (state guard).

**Measured evidence (scenario E — real TURN relay stopped after connect):**
```
17:13:35 ICE connection state: disconnected  (media stops; bytes stop growing)
17:13:36 Peer connection state: failed
17:13:36 Attempting ICE restart after a failed connection.
17:13:36 Offer skipped: signalingState is "have-local-offer".
final: connectionState=failed, iceConnectionState=disconnected,
       signalingState=have-local-offer, mediaFlowing=false
```
The restart was **never sent**. Even when the state is stable, the restart is a
single shot: `connectionState` only transitions to `failed` once, so a failed
restart is never retried, and there is no timer/backoff or timeout. Calling
`attemptIceRestart` from both the PC and ICE `failed` events duplicates the
attempt (the second is dropped by the `makingOffer` guard).

**Why it matters:** the intended fast recovery path is dead whenever D1 has
occurred — i.e. on any path whose ICE setup takes longer than the next
`session_state` push (TURN, mobile, real NAT). Recovery is then left to full PC
recreation (D3), which resets ICE/DTLS and audio.


### D3 — No terminal failure: unreachable paths churn peer connections and hide the failure (MEDIUM-HIGH)

**Where:** `callEngine.ts:1436-1454` — `applyPeers` keeps an existing PC unless
`connectionState` is `failed` or `closed`; on **every** subsequent
`session_state` a failed PC is destroyed and rebuilt, and a new offer is sent.
`closePeerConnection` (`1160-1191`) + `createPeerConnection` (`1193-1290`).
There is no failure latch, no retry counter, no backoff, and no user-facing error
on this path.

**Measured evidence (scenario F, host candidates suppressed, symmetric NAT):**
- 4 `RTCPeerConnection`s created per side in 56 s, with 1 open at any time.
- Each cycle: offer → answer → `checking` for ~15 s → `disconnected`/`failed` →
  next `session_state` recreates the PC and restarts ICE from zero.
- Final UI state: `callState="connecting"`, `lastError=null`,
  `mediaFlowing=false`, audio bytes 0, `dtlsState="new"`.

This is a genuine app defect layered on a genuine network limitation: the call
never converges to an actionable error, burns signaling/SDP/ICE work, and on a
flaky-but-recoverable link can repeatedly tear down a PC that might have
recovered.

### D4 — Stale remote-track callbacks are not generation-guarded (LOW-MEDIUM, code-confirmed)

`callEngine.ts:1278-1292` sets `event.track.onmute/onunmute/onended` which write
`this.remoteTrackState` and `emit()`. `closePeerConnection` (`1160-1191`) nulls
`pc.ontrack` but does not clear those per-track handlers and they carry no
`pc`/`generation` check (unlike every other PC callback). A late `ended`/`mute`
from a previous PC can therefore overwrite the state of the new PC, e.g. showing
"remote ended" while new audio is flowing. Not triggered in these runs; confirmed
by code inspection only.

### D5 — Empty ICE server list silently falls back to Google STUN (LOW)

`callEngine.ts:742-746` replaces any empty `iceServers` array with `DEFAULT_ICE`
(`164-173`, one Google STUN URL). Demonstrated by intercepting the ICE endpoint
to return `iceServers: []`: the call still connected via STUN
(`directnostun.json`), and the applied configuration was the default STUN entry.
For `policy=all` this masks a control-plane misconfiguration instead of failing
or reporting “no ICE servers”; it also contradicts the module's fail-closed
intent for relay mode.

### D6 — End-of-candidates is never signaled (LOW / observation)

`callEngine.ts:1228-1241`: a `null` candidate only logs “gathering complete”; no
`{candidate: null}` is relayed. Peers rely on ICE timers rather than an explicit
end-of-candidates. It did not affect any test (trickle works), but it slows
failure detection on one-sided gathering.

### D7 — Track-recovery renegotiation edge cases (LOW, latent)

`callEngine.ts:930-960`: with zero audio senders, `recoverLocalTrack` calls
`addTrack` but only the salesperson calls `makeOffer`; the customer (answerer)
has no `negotiationneeded` handler, so a newly added track may never be
negotiated until some other offer occurs. In the normal path (a sender already
exists) `replaceTrack` is used, which needs no renegotiation — yet the
salesperson still calls `makeOffer` afterwards, adding an unnecessary offer.
No failure was observed; mic tracks existed before PC creation in all runs.

## 6. What is *not* a defect / verified working

- Direct host connectivity with TURN absent (with or without STUN).
- Real relay media through an actual TURN server (`relay → relay`, DTLS and RTP
  through the relay, both directions).
- Relay-only without TURN fails **closed**: HTTP 503, error text in the UI,
  zero PCs, microphone never captured — no silent STUN fallback.
- Candidate buffering and remote-description ordering (delayed-offer test).
- ICE configuration applied to the PC (servers and `iceTransportPolicy` match
  the authenticated endpoint payload).
- Normal lifecycle: one PC, one audio sender, one remote audio track, playback
  element playing, diagnostics counters incrementing.
- No evidence of premature failure on a healthy direct path: transition was
  `new → checking/connecting → connected` in <100 ms.


## 7. Cross-network evidence and its limits

Genuinely different networks were **not available**. Both browser contexts ran on
the same host, behind one NAT, with the app on `127.0.0.1`. This sandbox has no
root, no user namespaces, and no `iptables`, so carrier-grade NAT, corporate
firewalls, or a second access network cannot be created or reached. The live
Render deployment could not be used either (HTTP 522) and must not be modified.

What was done instead:

* **Constrained-NAT simulation (scenario F):**
  `--force-webrtc-ip-handling-policy=default_public_interface_only` removed the
  usable host candidates. Both peers then used srflx candidates that mapped to
  the **same public IP** with different ports (`34.67.51.12:2048` and `:2049`),
  i.e. a symmetric-NAT-like mapping with no hairpinning. Result: host candidates
  were only `0.0.0.0`/`::`, all pairs stayed `in-progress`, no selected pair,
  zero RTP, never `connected`. This is a network limitation, and it is exactly
  the case the code warns about (`server/turn.ts:244`: “mobile-data or
  symmetric-NAT participants will have no audio”).
* **Real TURN control (scenario D/E)** proves the app can use a relay correctly
  and provides a working baseline when the direct path is impossible.

Consequences for the claim “direct WebRTC works”:

- On one LAN/NAT with a host-to-host path: **yes, verified**.
- Across NATs where STUN-reflexive candidates are reachable with hairpinning or
  port prediction: likely, but **not tested here**.
- Across mobile-carrier CGNAT, symmetric NAT, or UDP-restricted firewalls:
  **no evidence of direct success**, and the simulated symmetric-NAT case failed.
  TURN is required.
- Loopback browser contexts **cannot** reproduce carrier NAT or firewall policy.
  No statement of universal direct reliability is justified.

## 8. Reproduction

Artifacts (not part of the app) live in `.cline-investigation/`:

```
run-ice-probe.ts        # instrumented two-context harness
run.sh                  # LD_LIBRARY_PATH + browser env wrapper
run-scenario.sh         # background runner
results/*.json          # raw data: events, candidates, stats, byte counters
results/summary-*.json  # condensed per-scenario summaries
logs/*.log              # server + harness console output
turn/                   # local node-turn relay (dev-only dependency)
```

Commands used (after `npm ci`, `npm run build`, and installing Chromium/libs
into `.browser-libs` + `.apt`, both git-ignored):

```
.cline-investigation/run-scenario.sh direct                 # TURN absent, STUN only
HOST_ONLY=1 .cline-investigation/run-scenario.sh direct hostonly
DELAY_OFFER_MS=600 .cline-investigation/run-scenario.sh direct reorder
.cline-investigation/run-scenario.sh turn-all               # TURN available, policy all
.cline-investigation/run-scenario.sh turn-relay             # TURN forced
.cline-investigation/run-scenario.sh turn-relay-fail        # TURN stopped mid-call
.cline-investigation/run-scenario.sh direct-relay           # relay forced, no TURN
BROWSER_ARGS='--force-webrtc-ip-handling-policy=default_public_interface_only' \
  .cline-investigation/run-scenario.sh direct publiconly
```

Each run takes 20–60 s; `turn-relay-fail` waits up to 100 s after the relay is
stopped. Raw numbers quoted above are in the corresponding `results/*.json`.

## 9. Summary table of confirmed defects

| ID | Defect | Severity | Evidence | Trigger |
| --- | --- | --- | --- | --- |
| D1 | Presence-refresh re-offer during `connecting`; answerer drops it as duplicate; offerer stuck in `have-local-offer` | High | turn-relay, turn-relay-fail, publiconly | ICE setup slower than next `session_state` (TURN/NAT/mobile) |
| D2 | ICE restart skipped when signaling state is not `stable`; single-shot, no retry/backoff; dual triggers | High | turn-relay-fail | Any failure after D1; also any first restart that fails |
| D3 | Failed PC recreated on every presence update; no failure latch/backoff; UI stays `connecting` with no error | Medium-High | publiconly (4 PCs / 56 s) | Unreachable or unstable direct path |
| D4 | Remote-track `onmute/onunmute/onended` not generation-guarded/cleared | Low-Medium | code inspection | PC replacement while old track still emits events |
| D5 | Empty ICE server list silently replaced by Google STUN default | Low | directnostun | Control plane returns `iceServers: []` |
| D6 | No end-of-candidates signaling | Low | code inspection | Always; only affects gathering-complete detection |
| D7 | Track-recovery `addTrack` without negotiation on the answerer; unnecessary re-offer after `replaceTrack` | Low (latent) | code inspection | Mic track lost with no sender / recovery |

No fixes were implemented. No application code, Render setting, or deployment was
changed. The only repository additions are this report and the isolated test
harness under `.cline-investigation/`.

