# Self-hosted AI copilot on Modal

This replaces the hosted Ultravox call with a model service you own and run on
Modal. The human-to-human WebRTC call, sessions, invitation links, TURN/admin
configuration, authentication and the dashboards are **unchanged**.

> **Verified vs. not verified**
>
> - Automated tests cover: the server-side provider client, the browser audio
>   framing/protocol, the AI lifecycle/recovery logic, session/signaling
>   behaviour, the VAD, prompting and suggestion cleaning, and the call-token
>   signing. `npm test` passes.
> - **Not verified:** real audio streaming from a phone to a deployed Modal
>   container, faster-whisper accuracy on real calls, and the quality/latency of
>   the generated suggestions. No GPU, Modal account or phone was available in
>   the development environment. Do the checklist in section 7 before relying on
>   the AI in a real call.
> - If the AI path fails, the human call continues. That behaviour is tested.

## 1. Architecture

```
 salesperson browser ── WebRTC audio ── customer browser
        ▲                                      │
        │ ai_suggestion / customer_speech       │ 16 kHz PCM16 over WSS
        │ (text, via existing signaling)        ▼
   Render app server ── POST /v1/calls ──► Modal app (GPU, scale-to-zero)
        (holds AI_SERVICE_TOKEN)            faster-whisper + small instruct LLM
                                            └─ transcript/suggestion JSON
```

- Only the customer device captures a microphone for the AI (a second capture;
  the first one is the human call). The salesperson is never published to the AI.
- AI output is **text only**, so the model can never talk over either person.
- The browser only ever receives a signed, short-lived `wss://` URL. The service
  token and the signing secret stay on the server / in the Modal secret.
- The existing endpoint `POST /api/sessions/:id/ai-call` creates a call;
  `/ultravox-call` remains as an alias. Only the session's customer may call it.

## 2. What lives where

| Path | Purpose |
| --- | --- |
| `modal_app/app.py` | Modal app: `POST /v1/calls`, `DELETE /v1/calls/:id`, `GET /v1/health`, `WS /v1/stream`. Loads the models once per container. |
| `modal_app/pipeline.py` | Dependency-free VAD, prompt builder and suggestion cleaner (unit tested). |
| `modal_app/tokens.py` | HMAC call tokens for the `wss://` URL (unit tested). |
| `server/aiService.ts` | The only outbound provider client: URL/host validation, error mapping, redaction. |
| `src/lib/aiSession.ts` | Browser transport: microphone → 16 kHz PCM frames → WebSocket; JSON events → the existing AI lifecycle. |

## 3. Prerequisites (Android-only workflow)

Everything below can be done from a phone.

1. **Modal account** with the $30/month Starter credit.
   <https://modal.com/signup>
2. **Termux** (F-Droid build) with the tools:
   ```bash
   pkg update && pkg upgrade
   pkg install -y python git nodejs-lts
   pip install --upgrade modal
   ```
3. **Sign the CLI in**: `modal setup`. It prints a URL; open it in the phone
   browser and approve. The token is stored on the device by Modal.
4. **Repository on the phone**:
   ```bash
   git clone https://github.com/<you>/Ultraviolet-Coplt.git
   cd Ultraviolet-Coplt
   git checkout main
   ```
   (If you work from GitHub's web UI instead, upload the changed files with the
     GitHub app/web editor and run only the Modal commands below. `modal deploy`
     uploads `modal_app/` from the local checkout, so a local copy is required.)

## 4. Secrets

Generate two independent random values (never commit them):

```bash
python -c "import secrets; print('AI_SERVICE_TOKEN=' + secrets.token_urlsafe(32))"
python -c "import secrets; print('AI_CALL_SECRET=' + secrets.token_urlsafe(32))"
```

Store them as one Modal secret named `ai-service`:

```bash
modal secret create ai-service \
  AI_SERVICE_TOKEN='<first value>' \
  AI_CALL_SECRET='<second value>'
```

- `AI_SERVICE_TOKEN` authenticates your server to `POST /v1/calls`.
- `AI_CALL_SECRET` signs the per-call `wss://` join URL (default lifetime: the
  call's max duration, at most one hour).
- Both are readable only inside the Modal container and by you in the Modal
  dashboard. The app server needs only `AI_SERVICE_TOKEN`.

## 5. Deploy

```bash
modal deploy modal_app/app.py
```

The command prints the app's web URL, for example:

```
https://<workspace>--sales-copilot-ai-web.modal.run
```

- **First request is slow.** The container downloads ~1 GB of Whisper weights and
  ~6 GB of LLM weights, then loads them onto the GPU. The Modal Volume
  `ai-model-cache` keeps them between cold starts; the very first start can take
  several minutes. `startup_timeout` is 900 s for this reason.
- **Warm-up (recommended before a demo):**
  ```bash
  curl -s https://<workspace>--sales-copilot-ai-web.modal.run/v1/health
  ```
  This starts a container without creating a call. It costs GPU time while the
  container stays warm (`scaledown_window`, default 120 s).
- **Do not set `min_containers`** on the free/Starter credit: an always-warm GPU
  would burn the $30 in a few days.

## 6. Configure the app server (Render)

Set these in the Render dashboard (never in Git):

| Variable | Value |
| --- | --- |
| `AI_SERVICE_URL` | The Modal web URL from section 5, e.g. `https://<workspace>--sales-copilot-ai-web.modal.run` (origin only, no path) |
| `AI_SERVICE_TOKEN` | Same value as the Modal secret `AI_SERVICE_TOKEN` |
| `AI_SERVICE_MODEL` | Optional label only, e.g. `small.en+Qwen2.5-3B-Instruct` |
| `AI_MAX_CALL_SECONDS` | Optional, default `3600` |

`ULTRAVOX_API_KEY` is no longer read. Remove it from Render to avoid confusion.

Check readiness (configuration only, not liveness):

```bash
curl -s https://<your-render-app>/api/health | python -m json.tool
```

`ai.ready: true` means the two variables are valid. It does **not** mean the
Modal app is reachable or that audio works.


## 7. Verification checklist (do this on a real call)

The streaming path is **not** verified by the automated tests. Run these in
order; stop at the first failure.

1. **Service health (no GPU call created):**
   ```bash
   curl -s https://<workspace>--sales-copilot-ai-web.modal.run/v1/health
   ```
   Expect `{"status":"ok", ..., "protocol":"salescopilot-ai/1", ...}`. If it says
   `starting`, the container is still loading models; retry after a minute.
2. **Unauthenticated call creation is refused:**
   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' -X POST \
     https://<workspace>--sales-copilot-ai-web.modal.run/v1/calls \
     -H 'Content-Type: application/json' -d '{}'
   ```
   Expect `401`.
3. **Authenticated call creation works** (uses the secret locally; do not paste
   it into a chat or a screenshot):
   ```bash
   curl -s -X POST https://<workspace>--sales-copilot-ai-web.modal.run/v1/calls \
     -H "Authorization: Bearer $AI_SERVICE_TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{"sessionId":"manual-check","systemPrompt":"Be brief.","maxDurationSeconds":120}'
   ```
   Expect a `callId`, a `joinUrl` starting with `wss://` on the same host, a
   `model` label and an `expiresAt` in the future.
4. **App health after configuration:**
   ```bash
   curl -s https://<your-render-app>/api/health | grep -o '"ai":{[^}]*}'
   ```
   Expect `"ready":true`, `"provider":"modal-self-hosted"`, no secret values.
5. **Real call (two devices):** salesperson opens `/sales`, creates an
   invitation, the customer opens it on a phone and joins. Confirm, in order:
   - the salesperson dashboard's AI chip moves *Creating AI session →
     Connecting AI → AI connected* (it must **not** jump straight to
     "AI connected" without a live session);
   - the panel says the customer microphone reaches the AI;
   - speaking a clear sentence produces a customer transcript card within a few
     seconds;
   - a suggestion card appears with 1–2 readable sentences;
   - muting the customer stops new transcripts;
   - "Restart AI" (salesperson) creates a new call without dropping the human
     audio (the audio waveform/RTP counters must keep increasing).
6. **Logs:** `modal app logs sales-copilot-ai` (or the Modal dashboard) shows the
   session start/end. Transcripts and prompts are deliberately **not** logged;
   container logs must not contain `AI_SERVICE_TOKEN`, `AI_CALL_SECRET` or a
   `wss://` URL.

Expected latency (estimate, **not measured here**): 1–3 s after the customer
stops speaking on a T4 with `small.en` and a 3B model. If it is much slower, see
section 9.

## 8. Cost and the $30 credit

Modal bills per second of compute; there is no charge for idle containers beyond
`scaledown_window`. Current list prices (check <https://modal.com/pricing>):

| Resource | Price |
| --- | --- |
| T4 GPU | $0.000164/s ≈ **$0.59/hour** |
| L4 GPU | $0.000222/s ≈ $0.80/hour |
| A10 GPU | $0.000306/s ≈ $1.10/hour |
| CPU | $0.0000131 per core/s (this app requests 2 cores ≈ $0.094/hour) |
| Memory | $0.00000222 per GiB/s (16 GiB ≈ $0.128/hour) |

So one warm T4 container costs roughly **$0.81/hour** all-in, and $30 is about
**35–37 warm hours**. Estimates:

- 20-minute call, container already warm: ≈ $0.27 + 2 min idle ≈ **$0.30**.
- 20-minute call including a 2-minute cold start: ≈ **$0.33**.
- 90 warm minutes of demos: ≈ **$1.20**.

Cost controls already in place:

- `scaledown_window=120` — the container stops 2 minutes after the last
  connection; **never** set `min_containers`.
- `max_containers=2` — at most two GPUs can be billed concurrently.
- `maxDurationSeconds` ≤ 3600 per call, `MAX_SEGMENTS_PER_CALL=240` (a stuck
  client cannot run inference forever), 2 MiB WebSocket frame cap, and
  server-minted signed join URLs only.
- The Modal **Usage/Budgets** page can cap workspace spend; set a budget before
  the first demo.

To cut cost further: deploy with `SCALEDOWN_WINDOW=60`, use `ASR_MODEL=tiny.en`
(less accurate) or swap the LLM for `Qwen/Qwen2.5-1.5B-Instruct` via
`LLM_MODEL=... modal deploy modal_app/app.py` (needs ~4 GB VRAM and is faster,
with weaker suggestions).

## 9. Changing models or hardware

These are read at **deploy** time and baked into the container image:

```bash
# smaller/faster (less accurate) pair, cheaper idle window, one GPU max
ASR_MODEL=base.en \
LLM_MODEL=Qwen/Qwen2.5-1.5B-Instruct \
SCALEDOWN_WINDOW=60 \
MAX_CONTAINERS=1 \
modal deploy modal_app/app.py
```

Other supported variables: `AI_GPU` (default `T4`), `MAX_NEW_TOKENS` (default
96), `ASR_LANGUAGE` (default auto-detect; set `en` to save a little time),
`MAX_CALL_SECONDS`, `AI_DEVICE=cpu` for a no-GPU smoke test (very slow, but it
proves the wiring without spending GPU credits), and `AI_PUBLIC_URL` if Modal's
derived URL is not reachable from your phone.

After changing models, the first request downloads new weights into the
`ai-model-cache` Volume.

## 10. Troubleshooting and rollback

| Symptom | Cause / fix |
| --- | --- |
| `503 AI_SERVICE_NOT_CONFIGURED` on `/api/sessions/:id/ai-call` | `AI_SERVICE_URL` / `AI_SERVICE_TOKEN` are missing, are still `MY_...` placeholders, or the URL is not https. |
| `502 AI_SERVICE_UNREACHABLE` | Wrong host, Modal app stopped, or the phone/network cannot reach Modal. `curl .../v1/health` from the phone. |
| `502 AI_SERVICE_INVALID_RESPONSE` | The join URL host differs from `AI_SERVICE_URL` (e.g. `AI_PUBLIC_URL` set differently). Make them identical. |
| `401` from `/v1/calls` | The Render `AI_SERVICE_TOKEN` does not match the Modal secret. Re-create the secret and update Render. |
| WebSocket closes with code `4401` / `4404` | The signed URL expired, or the call record was deleted/never created (clock skew, or the POST and the socket hit different containers and the shared Dict is missing). Redeploy and retry; the app always requests a fresh call. |
| "AI service stopped responding" | The WebSocket died. The engine retries up to three times; the human call is unaffected. Check `modal app logs`. |
| AI chip stays on *Connecting AI* | The microphone capture or the WebSocket failed. Check browser permissions and the Modal logs; the 20 s connect timeout eventually reports an error. |
| Cold start takes minutes | Model download on the first ever run. Later starts use the Volume; warm the app before a demo. |
| `Could not load library libcudnn_ops.so` / CUDA errors in Modal logs | The image already installs `nvidia-cudnn-cu12`/`nvidia-cublas-cu12` and sets `LD_LIBRARY_PATH`. If you change the Python version or torch pin, update that path (`python3.11` in the image) or deploy with `AI_DEVICE=cpu` to confirm the rest of the wiring. |
| Suggestions arrive but are poor | Expected with a 3B model. Raise `LLM_MODEL` to a larger instruct model (A10/L40S GPU) or refine the system prompt in `server.ts` (it is operator-controlled and never taken from the browser). |

**Rollback:** the previous hosted implementation is one revert away:

```bash
git log --oneline --decorate -n 5
git revert <commit>
git push origin main
```

To disable the AI without reverting, remove `AI_SERVICE_URL` (or set it back to
the `MY_AI_SERVICE_URL` placeholder). Every AI request then returns
`503 AI_SERVICE_NOT_CONFIGURED`, the dashboards show "AI not started", and the
human-to-human call keeps working.

## 11. Tests you can run (no GPU, no Modal account)

```bash
npm run lint            # tsc --noEmit
npm test                # unit, TURN/admin, signaling, negotiation, AI lifecycle, AI client, AI service
npm run test:browser    # requires `npm run build` first and a local Chromium
npm run test:ai-pipeline  # python3 -m unittest discover -s modal_app/tests -t .
```

The Python tests need only the standard library. They cover the VAD, prompt
construction, suggestion cleaning and call-token signing.

