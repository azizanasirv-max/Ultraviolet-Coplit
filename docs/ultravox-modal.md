# Ultravox v0.5 on Modal (standalone service)

One GPU container that accepts a short customer audio clip and returns a short,
ready-to-speak suggestion for the salesperson. **Text only.** The model never
generates or plays audio, and nothing here is wired into the main application
yet.

- Model: `fixie-ai/ultravox-v0_5-llama-3_1-8b`
- Endpoints: `GET /v1/health` (public) and `POST /v1/suggest` (Bearer token)
- Files: `modal_app/ultravox_app.py` (Modal app), `modal_app/ultravox_api.py`
  (HTTP), `modal_app/ultravox_engine.py` (model), `modal_app/ultravox_core.py`
  (audio rules, stdlib only), `modal_app/tests/test_ultravox*.py`,
  `scripts/smoke_ultravox.py`, `scripts/check_ultravox_env.py` (offline
  preflight)

> **Status: reviewed, not deployed, and not verified against real weights.**
> A branch review on 2026-10-29 (see section 10) ran the pinned stack for real
> on CPU: the checkpoint's own custom code, the `ultravox-pipeline` contract,
> audio→16 kHz mono conversion of a real WebM/Opus recording, dependency
> resolution and Modal pricing. It also found and fixed three defects (cache
> path, `WAVE_FORMAT_EXTENSIBLE` fallback, GPU serialisation after a timeout).
> **Still unverified: the real 17.5 GB weight load, live A100-40GB capacity, and
> gated-repo access with a valid token.** No GPU has been started and nothing
> is deployed.

## 1. What the checkpoint actually needs (verified from the model card)

Checked on the Hub for revision `0af98d14…`:

| Fact | Value | Source |
| --- | --- | --- |
| Loading interface | `transformers.pipeline(model="fixie-ai/ultravox-v0_5-llama-3_1-8b", trust_remote_code=True)` | model card |
| Input format | `{"audio": float32 array, "turns": [...], "sampling_rate": 16000}` | model card + `ultravox_pipeline.py` |
| Audio | 16 kHz, mono; Whisper feature extractor (`sampling_rate: 16000`) | `preprocessor_config.json` |
| Custom code | `ultravox_model.py`, `ultravox_pipeline.py`, `ultravox_processing.py`, `ultravox_config.py` | repo file list |
| Checkpoint size | `model.safetensors` = 1 374 682 344 B (687 M params: audio tower + projector only) | Hub tree API |
| Text backbone | downloaded separately from **gated** `meta-llama/Llama-3.1-8B-Instruct` (`config.text_model_id`; `_create_language_model()` calls `AutoModelForCausalLM.from_pretrained`) | `config.json`, `ultravox_model.py` |
| Export metadata | `transformers_version: 4.48.1`, `torch_dtype: bfloat16` | `config.json` |
| Total download | ~1.37 GB + ~16.1 GB ≈ **17.5 GB** | Hub tree API + Llama 8B bf16 |
| Reference speed | TTFT ≈ 150 ms, 50–100 tok/s on an A100-40GB | model card |

Two consequences that drive the design:

1. **`HF_TOKEN` is mandatory.** `meta-llama/Llama-3.1-8B-Instruct` returns
   HTTP 401 `GatedRepo` without a token whose account accepted the Llama 3.1
   licence. `UltravoxConfig.__init__` also resolves that repo while reading the
   config, so a missing token fails at load, not mid-generation.
2. **A previous Whisper + Qwen path would be pointless.** Ultravox already
   contains a Whisper-large-v3-turbo encoder and a Llama-3.1-8B decoder, so the
   new path does not import `faster_whisper`, `WhisperModel` or any Qwen model.
   The old `modal_app/app.py` / `pipeline.py` / `tokens.py` (Whisper + Qwen) are
   **not** part of this branch; they remain on `origin/cline/b95pv7fx`. The tests
   assert the new deployment file contains none of those symbols.

### Dependency pins and why

| Package | Pin | Reason |
| --- | --- | --- |
| Python | 3.11 | `audioop` (used for fast resampling) is deprecated in 3.12 and removed in 3.13 |
| torch | 2.5.1 | CUDA 12.4 wheels, supports A100 (sm_80) and L40S (sm_89) |
| transformers | 4.48.1 | the release this checkpoint was exported with (`config.transformers_version`); its custom code depends on 4.x internals such as `torch_dtype` and `_init_weights` that later majors changed |
| accelerate | 1.3.0 | required by the checkpoint's `torch_dtype`/`device_map` load path |
| peft | 0.14.0 | `ultravox_model.py` imports `peft` unconditionally; no adapters are applied at inference (`r=0`) |
| numpy | 2.1.3 | audio array + Whisper feature extractor |
| fastapi / python-multipart | 0.115.6 / 0.0.20 | HTTP API + multipart uploads |

## 2. API contract

### `GET /v1/health` (public, no secrets)

```json
{"status":"ok","service":"ultravox-suggestions",
 "model":"fixie-ai/ultravox-v0_5-llama-3_1-8b","modelLoaded":true,
 "sampleRate":16000,"maxAudioSeconds":60,"maxNewTokens":64,
 "inferenceTimeoutSeconds":25.0,"output":"text"}
```

`status` is `starting` until the model finishes loading. No token, audio or
environment values are returned.

### `POST /v1/suggest` (requires `Authorization: Bearer $ULTRAVOX_SERVICE_TOKEN`)

Either JSON:

```json
{"audioBase64":"<base64 WAV>","mimeType":"audio/wav",
 "context":"optional recent transcript","maxNewTokens":64}
```

or `multipart/form-data` with a file field `audio` plus optional `context` and
`maxNewTokens` fields.

Success (200):

```json
{"suggestion":"Happy to walk you through the pilot pricing.",
 "emptyReason":null,"note":null,
 "model":"fixie-ai/ultravox-v0_5-llama-3_1-8b",
 "audioDurationMs":1200,"latencyMs":1180,"requestId":"9f2c..."}
```

`emptyReason` is `NO_SPEECH` when the model produced nothing usable (silence,
refusal, or the explicit `NO_SPEECH` marker); the request still returns 200 so
the caller can tell "heard nothing" apart from "failed".

Errors use `{"error":{"code","message"}}`:

| Status | Code | When |
| --- | --- | --- |
| 400 | `EMPTY_AUDIO`, `AUDIO_TOO_SHORT`, `INVALID_BASE64`, `INVALID_AUDIO_FIELD`, `INVALID_JSON`, `MISSING_AUDIO`, `INVALID_MULTIPART` | bad request |
| 401 | `UNAUTHORIZED` | missing/wrong bearer token |
| 413 | `AUDIO_TOO_LARGE`, `AUDIO_TOO_LONG`, `REQUEST_TOO_LARGE` | over limits |
| 415 | `UNSUPPORTED_MEDIA_TYPE`, `UNSUPPORTED_AUDIO_FORMAT` | not decodable |
| 502 | `INFERENCE_FAILED` | model/processor raised |
| 503 | `SERVICE_NOT_CONFIGURED`, `MODEL_LOADING` | missing secret / cold start |
| 504 | `INFERENCE_TIMEOUT` | generation exceeded the deadline |
| 500 | `INTERNAL_ERROR` | unexpected; internals are logged, never returned |

Limits (deploy-time env, defaults): audio ≤ 60 s (`ULTRAVOX_MAX_AUDIO_SECONDS`,
hard cap 120), ≤ 12 MiB payload, `maxNewTokens` ≤ 160, inference deadline 25 s
(`ULTRAVOX_INFERENCE_TIMEOUT_SECONDS`, cap 60).

### System prompt (requirement 6)

`modal_app/ultravox_core.py` holds it and the caller cannot override it with
arbitrary text (the endpoint only accepts recent `context`):

- role: sales copilot listening live, hears the customer through the audio;
- task: the salesperson's next line — one short, relevant, ready-to-speak
  suggestion;
- constraints: **text only**, never produce/describe audio, one or two short
  sentences (~25 words), no labels/preamble/quotes/bullets, no made-up facts;
- silence → the literal `NO_SPEECH`, which the API maps to `emptyReason`.

The final chat turn is the documented `<|audio|>` placeholder, so the audio is
the last thing in the model's context.

## 3. Secrets and deployment (do not run until approved)

### 3.1 Required secrets

Create the Hugging Face token first at
<https://huggingface.co/settings/tokens> (read scope) and accept the Llama 3.1
licence at <https://huggingface.co/meta-llama/Llama-3.1-8B-Instruct>.

```bash
# 1. Inference token: your server will send this, never a browser.
python3 -c "import secrets; print('ULTRAVOX_SERVICE_TOKEN=' + secrets.token_urlsafe(32))"

# 2. One Modal secret with both values (kept server-side, never in Git).
modal secret create ultravox-service \
  ULTRAVOX_SERVICE_TOKEN='<paste value 1>' \
  HF_TOKEN='hf_<paste your Hugging Face token>'
```

`modal_app/ultravox_app.py` reads them with
`modal.Secret.from_name("ultravox-service", required_keys=[...])`, so a missing
key fails at deploy instead of silently starting an unauthenticated service.
The token is compared with `hmac.compare_digest`; if it is missing at runtime
the endpoint returns 503 `SERVICE_NOT_CONFIGURED` and never runs inference.
No secret is written to disk in this repo.

### 3.2 Deploy commands (in order)

```bash
# 0. One-off: install the CLI and sign in (browser/device flow).
pip install --upgrade modal
modal setup

# 1. Optional: prove the app object builds without deploying anything.
python3 -c "import modal_app.ultravox_app as m; print(m.MODEL_ID, m.GPU_TYPES)"

# 2. Pre-download ~17.5 GB of weights into the Volume on CPU (no GPU billed).
modal run modal_app/ultravox_app.py::download_models

# 3. Deploy. First build installs torch/transformers/ffmpeg (~3-6 min).
modal deploy modal_app/ultravox_app.py
# add --stream-logs to watch the container start (optional)
```

`modal deploy` prints the web URL, e.g.
`https://<workspace>--ultravox-v05-service-web.modal.run`.

Costs of steps 2-3: the preload downloads 17.5 GB on a 4-core/16 GiB CPU
container (~3-5 min) and the image build is also CPU-only — together roughly
$0.03-0.06. **No GPU time is billed until the first request or health check.**

### 3.3 Smoke test (submits audio, returns text)

```bash
export ULTRAVOX_SERVICE_TOKEN='<same value as the Modal secret>'
export ULTRAVOX_SERVICE_URL='https://<workspace>--ultravox-v05-service-web.modal.run'

# health (starts a GPU container on the first call)
python3 scripts/smoke_ultravox.py --url "$ULTRAVOX_SERVICE_URL" --health

# short audio sample -> text suggestion
python3 scripts/smoke_ultravox.py --url "$ULTRAVOX_SERVICE_URL" \
  --audio /path/to/customer-question.wav

# equivalent curl form (multipart)
curl -sS -X POST "$ULTRAVOX_SERVICE_URL/v1/suggest" \
  -H "Authorization: Bearer $ULTRAVOX_SERVICE_TOKEN" \
  -F 'audio=@/path/to/customer-question.wav;type=audio/wav' \
  -F 'context=Customer asked how onboarding works.'
```

Without `--audio` the script sends a generated tone. That exercises the whole
path but contains no speech, so an empty `suggestion` with
`emptyReason: "NO_SPEECH"` is the expected result — it is not a failure.

`--audio` should be a **WAV** clip: 16 kHz mono is ideal, but anything the
stdlib `wave` module reads (8/16/24/32-bit, mono/stereo, 8-192 kHz) is
downmixed and resampled to 16 kHz mono. Other containers (webm/opus from a
browser recorder, mp3, m4a) are transcoded with `ffmpeg`, which the image
installs.

### 3.4 Operating notes

- One container at a time (`max_containers=1`), one GPU, `min_containers=0`.
- `scaledown_window=300` s (5 min idle). Lower it to 120 s to save credit.
- The engine has a lock, so concurrent requests queue for the GPU; input
  concurrency (`max_inputs=4`) only keeps `/v1/health` responsive.
- Cold start ≈ 60-120 s (Volume read of 17.5 GB + bf16 load + CUDA context).
  Warm the service before a demo with the health call.
- Logs contain request id, audio duration, latency and character count only —
  never audio, never the token. Tail with `modal app logs ultravox-v05-service`.


## 4. GPU: what to request and what it costs

### 4.1 Requirements

| Resource | Value | Why |
| --- | --- | --- |
| GPU | 1 × A100 40 GB (`A100-40GB`), first choice | bf16 weights ≈ 17.5 GB + activations/KV fit comfortably; the model card benchmarks on exactly this GPU |
| GPU fallback | `L40S` (48 GB), listed second in `ULTRAVOX_GPU` | Modal respects list order and falls back automatically when the preferred type is unavailable |
| CPU | 4 cores | image/audio decode + host-side tensor work |
| RAM | 24 GiB | 17.5 GB checkpoint is read and converted on the host before the GPU copy |
| Disk | ~20 GB ephemeral | safetensors staging |
| Volume | `ultravox-model-cache`, ~17.5 GiB | avoids re-downloading on every cold start |
| Startup timeout | 1800 s | first download + load |
| Request timeout | 180 s | generation bound (internal deadline 25 s) |

Modal advertises both A100 sizes and the L40S, and documents `gpu=[...]`
fallbacks and the `A100` → 80 GB free upgrade (excluded here by naming
`A100-40GB` explicitly). **Live capacity is per-workspace/region and cannot be
confirmed without an account**; that is the one deployment-time unknown for
requirement 3.

### 4.2 Price per hour (Modal list prices, per second)

| GPU | $/s | $/h (GPU) | +4 cores & 24 GiB | Hours per $30 |
| --- | --- | --- | --- | --- |
| **A100-40GB** | 0.000583 | **$2.10** | **$2.48** | **12.1** |
| L40S (48 GB) | 0.000542 | $1.95 | $2.33 | 12.9 |
| A100-80GB | 0.000694 | $2.50 | $2.88 | 10.4 |
| H100 | 0.001097 | $3.95 | $4.33 | 6.9 |

CPU is $0.0000131/core/s (4 cores = $0.19/h) and memory $0.00000222/GiB/s
(24 GiB = $0.19/h). Volume storage is $0.09/GiB/month, but Modal's 1 TiB/month
free allowance covers 17.5 GiB, so storage is effectively $0 here (~$1.57/mo if
the allowance were exhausted).

### 4.3 Estimated spend against the $30 credit

| Item | Estimate |
| --- | --- |
| Image build (first deploy, CPU only) | ~3-6 min → $0.02-0.04 |
| Weight download (preload, CPU only) | 17.5 GB, ~3-5 min → $0.02-0.03 |
| Volume storage | $0 (1 TiB free tier) |
| Cold start (Volume read + load) | 60-120 s → **$0.04-0.08** |
| One warm suggestion (64 tokens) | ~1-1.5 s → **~$0.0008** |
| 1 hour of continuous/demo use, warm | **≈ $2.50** |
| $30 buys, all-in | **≈ 12 h warm**, or ≈ 480 isolated cold-start requests |

**Sparse traffic is the cost trap.** Each request that arrives after the
idle window pays a full cold start (~90 s, ~$0.06) for ~1 s of useful work:
100 spread-out requests/day ≈ $6/day ≈ $186/month. Keep the service warm only
while demoing (health call, then a burst of requests), set
`ULTRAVOX_SCALEDOWN_WINDOW=120` for tighter budgets, and do not set
`min_containers=1` (an always-warm A100-40GB would burn $30 in ~12 hours).

### 4.4 Tunables (read at deploy time)

```bash
# strict A100-40GB only (may queue when unavailable)
ULTRAVOX_GPU="A100-40GB" modal deploy modal_app/ultravox_app.py

# cheapest 48 GB option
ULTRAVOX_GPU="L40S" modal deploy modal_app/ultravox_app.py

# cheaper idle behaviour / shorter answers / longer audio
ULTRAVOX_SCALEDOWN_WINDOW=120 ULTRAVOX_MAX_NEW_TOKENS=48 \
ULTRAVOX_MAX_AUDIO_SECONDS=30 modal deploy modal_app/ultravox_app.py
```

Other variables: `ULTRAVOX_APP_NAME`, `ULTRAVOX_MODEL_ID`,
`ULTRAVOX_SECRET_NAME`, `ULTRAVOX_VOLUME_NAME`, `ULTRAVOX_MAX_CONTAINERS`
(keep 1), `ULTRAVOX_MAX_INPUTS`, `ULTRAVOX_REQUEST_TIMEOUT`,
`ULTRAVOX_STARTUP_TIMEOUT`, `ULTRAVOX_CPU`, `ULTRAVOX_MEMORY_MB`,
`ULTRAVOX_MAX_AUDIO_BYTES`, `ULTRAVOX_INFERENCE_TIMEOUT_SECONDS`,
`ULTRAVOX_DEVICE=cpu` (wiring-only; an 8B model on CPU takes minutes per


## 5. Tests (no GPU, no Modal account, no HF token)

```bash
npm run test:ultravox
# or
python3 -m unittest discover -s modal_app/tests -t . -p 'test_ultravox*.py'
```

98 tests, all passing in this checkout (2026-10-29: 93 pass + 5 skipped without
`ffmpeg`; 98/98 with a real `ffmpeg` on PATH). Coverage:

| Requirement | Tests |
| --- | --- |
| model loading | `test_ultravox_engine.LoadingTests` (model id, device, idempotent load, load failure → `ModelLoadError`, missing `HF_TOKEN` → `HF_TOKEN_MISSING` before any download, default loader), `test_ultravox_modal_app` (checkpoint id, GPU order, conservative scaling, preload cache path, no Whisper/Qwen) |
| audio validation | `test_ultravox_core.AudioValidationTests`, `WavDecodeTests`, `FfmpegTests`, `ExtensibleWavTests` (empty, oversize, wrong type, corrupt WAV, 3 channels, too short/long, stereo 48 k → mono 16 k, 8-bit widening, `WAVE_FORMAT_EXTENSIBLE` fallback, ffmpeg path) |
| real recordings | `test_ultravox_audio_real` (real WebM/Opus 48 kHz mono + stereo → 16 kHz mono; real `WAVE_FORMAT_EXTENSIBLE`; multipart and base64 uploads through the API). Skipped when `ffmpeg` is absent |
| inference response parsing | `ParseSuggestionTests`, `SuggestTests.test_output_is_cleaned`, `test_no_speech_output_becomes_empty_string`, `test_unexpected_model_output_raises_inference_error` |
| authentication | `AuthTests` (core) + `test_ultravox_api.AuthTests` (401 missing/wrong, 503 unconfigured, no inference on failure) |
| timeout handling | `DeadlineTests`, `SuggestTests.test_slow_generation_raises_inference_timeout`, `test_gpu_work_stays_serialised_after_a_timeout`, `test_ultravox_api.FailureTests.test_inference_timeout_returns_504` |
| error reporting | `test_ultravox_api.ValidationTests` + `FailureTests` (400/401/413/415/500/502/503/504, no internals leaked) |
| input contract | `SuggestTests.test_inputs_follow_the_documented_audio_plus_turns_format` (audio float32 @16 kHz, `turns` ending in `<|audio|>`, `sampling_rate=16000`, greedy decoding) |

`ultravox_core` tests need only the stdlib; engine/API/app tests use `numpy`,
`fastapi`, `httpx` and `modal` when installed and skip cleanly when they are
not. The real-recording tests need a real `ffmpeg` binary and skip without it:

```bash
# offline environment preflight (no network, no GPU)
python3 scripts/check_ultravox_env.py

# the 5 real WebM/Opus + WAVE_FORMAT_EXTENSIBLE tests (needs ffmpeg on PATH)
python3 -m unittest modal_app.tests.test_ultravox_audio_real -v
```

`scripts/smoke_ultravox.py` was run against a local uvicorn instance of the app
with a fake engine: health, JSON and multipart requests, 401 and exit codes all
behaved as documented. That is HTTP wiring coverage, not model coverage.

## 6. Verification checklist for the first approved deployment

Run in order; stop at the first failure and report it.

1. `modal run modal_app/ultravox_app.py::download_models` → returns
   `weights cached in /models/hf/hub`; confirms the HF token and gated access.
   Then `modal volume ls ultravox-model-cache /hf/hub` must list
   `models--fixie-ai--ultravox-v0_5-llama-3_1-8b` and
   `models--meta-llama--Llama-3.1-8B-Instruct`, and the GPU container must read
   them instead of re-downloading.
2. `modal deploy modal_app/ultravox_app.py` → prints a `…modal.run` URL.
3. `curl <url>/v1/health` → starts a container; in `modal app logs` confirm
   `cuda_available=True device=A100-SXM4-40GB vram_gib≈40` and
   `[ultravox] model loaded`. If the log shows an L40S, Modal fell back.
4. `curl <url>/v1/health` again → `{"status":"ok","modelLoaded":true}`.
5. Unauthenticated inference is refused (expect 401):
   `curl -s -o /dev/null -w '%{http_code}\n' -X POST <url>/v1/suggest -H 'Content-Type: application/json' -d '{}'`
6. `python3 scripts/smoke_ultravox.py --url <url> --audio <real-clip.wav>` →
   200 with a non-empty `suggestion` and a plausible `latencyMs`.
7. Repeat step 6 with a clip of *silence* → 200 with `emptyReason: "NO_SPEECH"`.
8. `modal app logs ultravox-v05-service` → no audio and no token in the logs.
9. Dashboard usage: confirm the spend for steps 2-8 is in the cents range.

## 7. Still unverified (do not claim otherwise)

- **The real weights have never been loaded.** No GPU, no Modal account and no
  valid HF token were available. The pinned stack, this checkpoint's own custom
  code and its pipeline contract were exercised on CPU with tiny random weights
  (section 10), but `pipeline(model="fixie-ai/…")` against the 17.5 GB
  checkpoint is untested.
- **Whether Modal actually provisions `A100-40GB`** in this workspace/region.
  The fallback list makes L40S automatic, but live capacity was not observed.
- **Cold-start time, host RAM peak, tokens/s and TTFT** are estimates derived
  from the model card (A100-40GB: ~150 ms TTFT, 50-100 tok/s) and the 17.5 GB
  weight size.
- **Gated access with a *valid* token**: the mechanism is verified (env token →
  `Authorization: Bearer` header; 401 without it), but this account has no
  Llama-3.1 approval, so the actual download was never completed.
- **Modal image build**: the exact pip pins resolve together and `pip check` is
  clean, but the image itself was never built (needs an account).
- **Suggestion quality** on real sales audio, and whether `NO_SPEECH` triggers
  as intended on silence.
- **Nothing is integrated into the app**: no `server/`, `src/` or `.env.example`
  change, no hosted Ultravox removal, and no client calls this service yet.

## 8. Rollback and cleanup

```bash
modal app stop ultravox-v05-service        # stops containers immediately
modal volume ls ultravox-model-cache       # inspect cached weights (17.5 GB)
modal volume delete ultravox-model-cache   # delete them when done, free storage
modal secret delete ultravox-service       # remove both credentials
```

Nothing in this branch touches the running application, so reverting the branch
is enough to remove the service from the repo. The previous Whisper + Qwen
implementation lives on `origin/cline/b95pv7fx`.

## 9. Why this is safe to leave running

- Inference requires the bearer token; a missing token fails closed (503).
- Health is the only public endpoint and exposes capability flags only.
- Audio is capped (60 s / 12 MiB) and answers at 160 tokens max, so a
  pathological request cannot pin the GPU indefinitely.
- One container, scale-to-zero, 5-minute idle window: no spend when unused.
- The service returns text only and never streams audio back, so it cannot talk
  over either participant.

## 10. Branch review — 2026-10-29 (no deployment, no GPU)

Evidence produced without starting a GPU, creating a secret or deploying:

| # | Question | Result |
| --- | --- | --- |
| 1 | Model card / `transformers.pipeline` contract | **Verified.** Card's snippet is exactly `pipeline(model=..., trust_remote_code=True)` + `{"audio", "turns", "sampling_rate"}`. transformers 4.48.1's `pipeline()` signature accepts `torch_dtype`, `device`, `trust_remote_code`, `token`, and infers the checkpoint's `ultravox-pipeline` from `config.custom_pipelines` (pipelines/__init__.py:855). |
| 2 | Pin compatibility | **Verified on CPU.** `torch==2.5.1`, `transformers==4.48.1`, `peft==0.14.0`, `accelerate==1.3.0`, `numpy==2.1.3` install together, `pip check` clean, `tokenizers==0.21.4`. The checkpoint's `ultravox_model.py` imports and runs: `ModifiedWhisperEncoder` → `(1, 1500, 32)`, projector → `(1, 188, 64)`, `LlamaForCausalLM(inputs_embeds=...)` → `(1, 188, 128256)`, and `ultravox-pipeline` registers. |
| 3 | Gated Llama backbone + server-side token | **Mechanism verified.** The Hub returns 401 for the gated file without a valid token. The checkpoint forwards **no** token (`SHARED_PRETRAINED_KWARGS` has only dtype/device options), so env auth is the only path: with `HF_TOKEN` set, `build_hf_headers()` returns `Authorization: Bearer …`; without it, none. `require_hf_token()` now fails fast with `HF_TOKEN_MISSING`. A real approved token was not available. |
| 4 | Image build, volume, secret, GPU fallback, scale-to-zero | **Partly verified.** The Modal SDK 1.6.3 builds the app object, accepts `gpu=["A100-40GB","L40S"]`, `min_containers=0`, `max_containers=1`, `scaledown_window=300`, `@modal.concurrent` and `Secret.from_name(..., required_keys=…)`. Pins resolve. **Found and fixed: the preload wrote to `/models/hf/models--*` while transformers reads `/models/hf/hub/models--*`, so every cold start would have re-downloaded 17.5 GB on the GPU.** Actual build/volume round-trip not exercised. |
| 5 | Real browser WebM/Opus → 16 kHz mono → text | **Audio path verified end to end**, text generation verified only with a fake model. A real `ffmpeg` 7.0.2 + libopus encode of 48 kHz mono and stereo WebM/Opus decodes to 16 kHz mono PCM16 (1 s → ~16 000 samples) and returns 200 through `/v1/suggest` via both multipart and base64. **Found and fixed:** `WAVE_FORMAT_EXTENSIBLE` WAV (common from desktop recorders) was rejected with 415 on a WAV magic match; it now falls back to ffmpeg. |
| 6 | Prices / startup estimates | **Re-verified against modal.com/pricing** (see §4.2): A100-40GB $0.000583/s, A100-80GB $0.000694/s, L40S $0.000542/s, H100 $0.001097/s, CPU $0.0000131/core/s, RAM $0.00000222/GiB/s, volumes $0.09/GiB/mo with 1 TiB free, Starter $30/mo. All-in $2.48/h and 12.1 h per $30 are correct; cold start ≈ $0.06 and warm request ≈ $0.0008 match. |
| 7 | Tests | **98 tests, all passing** (93 + 5 skipped without ffmpeg; 98/98 with it). Then re-run after the fixes: same result. |

### Defects found by this review and fixed

1. **Preload cache path** (`modal_app/ultravox_app.py`): removed `cache_dir=`
   from `snapshot_download` so it writes to `HF_HOME/hub`, the path
   `transformers` reads. Without this, the 17.5 GB download would repeat on
   every cold start — on GPU-billed time.
2. **`WAVE_FORMAT_EXTENSIBLE` WAV** (`modal_app/ultravox_core.py`):
   `decode_audio` now retries such files with ffmpeg instead of returning 415.
   Non-format errors (too long/too short) are still not retried.
3. **GPU serialisation after a timeout** (`modal_app/ultravox_engine.py`): a
   timed-out generation kept running while the lock was released, so the next
   request could start a second generation on the same GPU. The engine now owns
   a single-worker executor, so queued work waits for the abandoned generation.

Additions: `require_hf_token()` preflight, `scripts/check_ultravox_env.py`
(14 offline checks on versions/API surface/token plumbing, exits non-zero on
failure), `modal_app/tests/test_ultravox_audio_real.py`, plus 16 new tests.

### Minimum remaining steps before a controlled first deployment

1. **Hugging Face access** (blocker, account-level): accept the Llama 3.1
   licence, create a read token, and confirm
   `hf_hub_download("meta-llama/Llama-3.1-8B-Instruct", "config.json")` succeeds
   for that token.
2. **Modal account/CLI** (blocker): `modal setup`, verify the workspace has
   A100-40GB capacity (or accept the L40S fallback), and set a workspace budget
   before the first GPU start.
3. **Approval** for ~$0.06 (image build + CPU preload) and then ~$0.06 per cold
   start.
4. Then follow §3.2 → §6 exactly: preload → deploy → health → 401 check →
   real-audio smoke test → silence test → log inspection → usage check.
5. Only after that: wire `AI_SERVICE_URL`/token into the app server in a
   separate change (still out of scope here).
