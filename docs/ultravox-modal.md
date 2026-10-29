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
  `scripts/smoke_ultravox.py`

> **Status: not deployed and not verified against real weights.**
> This checkout had no GPU, no Modal account and no Hugging Face token, so the
> model has never been loaded here. Everything below marked *verified* is
> covered by the unit tests or by a local run of the API with a fake engine.
> The *Unverified* section lists exactly what the first approved deployment
> must confirm.

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

82 tests, all passing in this checkout (Python 3.11, fake model). Coverage:

| Requirement | Tests |
| --- | --- |
| model loading | `test_ultravox_engine.LoadingTests` (model id, device, idempotent load, load failure → `ModelLoadError`, default loader), `test_ultravox_modal_app` (checkpoint id, GPU order, conservative scaling, no Whisper/Qwen) |
| audio validation | `test_ultravox_core.AudioValidationTests`, `WavDecodeTests`, `FfmpegTests` (empty, oversize, wrong type, corrupt WAV, 3 channels, too short/long, stereo 48 k → mono 16 k, 8-bit widening, ffmpeg path) |
| inference response parsing | `ParseSuggestionTests`, `SuggestTests.test_output_is_cleaned`, `test_no_speech_output_becomes_empty_string`, `test_unexpected_model_output_raises_inference_error` |
| authentication | `AuthTests` (core) + `test_ultravox_api.AuthTests` (401 missing/wrong, 503 unconfigured, no inference on failure) |
| timeout handling | `DeadlineTests`, `SuggestTests.test_slow_generation_raises_inference_timeout`, `test_ultravox_api.FailureTests.test_inference_timeout_returns_504` |
| error reporting | `test_ultravox_api.ValidationTests` + `FailureTests` (400/401/413/415/500/502/503/504, no internals leaked) |
| input contract | `SuggestTests.test_inputs_follow_the_documented_audio_plus_turns_format` (audio float32 @16 kHz, `turns` ending in `<|audio|>`, `sampling_rate=16000`, greedy decoding) |

`ultravox_core` tests need only the stdlib; engine/API/app tests use `numpy`,
`fastapi`, `httpx` and `modal` when installed and skip cleanly when they are
not.

`scripts/smoke_ultravox.py` was run against a local uvicorn instance of the app
with a fake engine: health, JSON and multipart requests, 401 and exit codes all
behaved as documented. That is HTTP wiring coverage, not model coverage.

## 6. Verification checklist for the first approved deployment

Run in order; stop at the first failure and report it.

1. `modal run modal_app/ultravox_app.py::download_models` → returns
   `weights cached in /models/hf`; confirms the HF token and gated access.
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

- **The model has never been loaded in this environment.** No GPU, no Modal
  account and no HF token were available, so `transformers==4.48.1` +
  `trust_remote_code` + this checkpoint is untested end to end. The pins come
  from the checkpoint's `transformers_version` and its released requirements,
  not from a successful load here.
- **Whether Modal actually provisions `A100-40GB`** in this workspace/region.
  The fallback list makes L40S automatic, but live capacity was not observed.
- **Cold-start time, host RAM peak, tokens/s and TTFT** are estimates derived
  from the model card (A100-40GB: ~150 ms TTFT, 50-100 tok/s) and the 17.5 GB
  weight size.
- **Pipeline return type**: the engine expects the custom pipeline to return a
  `str` (as its `postprocess` does). Anything else becomes a 502 by design; that
  mapping is tested, but not observed on real weights.
- **`peft==0.14.0` / `accelerate==1.3.0`** with `transformers==4.48.1` and
  `torch==2.5.1` was not resolved by a real image build here.
- **ffmpeg transcoding of a real browser webm/opus recording** (unit tested with
  an injected runner only).
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
