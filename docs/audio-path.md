# Human-to-human audio path (salesperson ↔ customer)

Prototype 2 has **two independent audio paths**. Keeping them separate is why a
working AI transcript says nothing about whether the people can hear each other.

| Path | Transport | Direction |
| --- | --- | --- |
| AI conversation | Ultravox / LiveKit (customer device only) | customer mic → AI, AI text → dashboard |
| Human call | Direct `RTCPeerConnection` (salesperson = offerer, customer = answerer) | customer mic ↔ salesperson mic |

Both use the same `/ws` WebSocket for signalling; AI text is relayed over that
socket (`ai_suggestion`), the call media is peer-to-peer RTP.

## What was wrong

1. **No TURN relay was configured.** The `RTCPeerConnection` only had STUN
   servers. Verified by gathering candidates in a browser against the deployed
   configuration: `host` and `srflx` only, and `iceTransportPolicy: 'relay'`
   produced **no candidates at all**. STUN can only discover a public address;
   it cannot relay media. When the two devices cannot reach each other directly
   (customer on mobile data / CGNAT, corporate Wi-Fi, UDP blocked) the call
   stays dead in *both* directions while the AI pipeline keeps working, because
   Ultravox/LiveKit has its own TURN infrastructure.

2. **The remote `<audio>` element was never unlocked by a user gesture.** It was
   `display:none` and `play()` was only called from the async `ontrack` handler.
   Browsers that require a gesture per media element (iOS Safari in particular)
   reject that call with `NotAllowedError`, producing "P2P Audio Connected" with
   total silence. The only hint was a small amber pill in the header.

3. **Silent failure modes were invisible.** The UI showed the ICE/PC state only,
   which cannot distinguish a blocked audio element from a muted microphone
   track from RTP that never arrives.

4. **The customer's mute button only muted the P2P track**, so the AI kept
   listening while the customer believed they were muted.

## What was changed

| File | Change |
| --- | --- |
| `server.ts` | `GET /api/ice-config` resolves `STUN_URLS`, `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL`, `ICE_TRANSPORT_POLICY` from the environment; `hasTurn` added to `/api/health`. |
| `src/components/Prototype2View.tsx` | Fetches the ICE config and builds the peer connection with it; unlocks the audio element inside the Join gesture (silent WAV) and swaps in the remote stream; keeps the element in the DOM (not `display:none`); blocking "Enable Audio" banner; retry on any tap; local mic track `mute`/`unmute`/`ended` monitoring with automatic `replaceTrack` recovery; ICE candidate-type accounting and `icecandidateerror` logging; live diagnostics panel (`window.__p2pDiagnostics()`); customer mute now also mutes the Ultravox microphone; mute + diagnostics controls added to the salesperson dashboard. |
| `.env.example` | TURN/STUN/ICE policy documentation. |
| `scripts/p2p-audio-diagnostic.mjs` | Two-browser-context end-to-end check of the real UI: asserts both peers create a `RTCPeerConnection`, that microphone sender and remote receiver tracks exist, that audio RTP flows **in both directions** and that the remote `<audio>` is attached, unmuted and playing. |
| `scripts/signaling-relay-test.mjs` | Server relay test: offer/answer/ICE relaying, AI suggestion relay, role rules, `peer_left`. |

## Verifying a deployment

```bash
npm start                                  # or deploy

npm run diag:signaling -- ws://localhost:3000/ws
npx playwright install chromium
npm run diag:p2p -- http://localhost:3000  # add DIAG_ORDER=customer-first to reverse join order
```

`diag:p2p` reports PASS/FAIL for every hop. It uses Chromium's fake microphone,
so it proves the signalling and media plumbing, not physical-device acoustics.

## Real two-device check

On each device open the room, press **Join**, then open **Diagnostics**.

| Field | Expected |
| --- | --- |
| `PC / ICE state` | `connected` / `connected` on both devices |
| `ICE candidates` | `relay` > 0 when the devices are on different networks |
| `Selected path` | any type; `(TURN relay)` when no direct path exists |
| `Local mic track` | `live/enabled/live` |
| `Remote audio tracks` | `1` |
| `Audio element` | `attached · unmuted · playing` |
| `RTP send / receive` | non-zero kbps **in both directions** |

If `RTP send / receive` is `0 / 0` while the AI text keeps updating, the devices
have no media path — configure TURN (see `.env.example`). If RTP is non-zero but
you hear nothing, check the device volume/output route and the `Audio element`
row; the `Enable Audio` banner must be dismissed.
