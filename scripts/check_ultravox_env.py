#!/usr/bin/env python3
"""Preflight: does this environment match what Ultravox v0.5 needs?

Checks only the installed library surface and the token plumbing; it downloads
nothing and needs no GPU. Run it locally, or inside the Modal image before the
first inference (`modal shell ultravox-v05-service` then run this file).

    python3 scripts/check_ultravox_env.py

Exit code 0 means every check passed. Any FAIL means the image should not be
used to load the model.
"""

from __future__ import annotations

import inspect
import os
import sys

EXPECTED = {
    "torch": "2.5.1",
    "transformers": "4.48.1",
    "peft": "0.14.0",
    "accelerate": "1.3.0",
    "numpy": "2.1.3",
}

results: list[tuple[bool, str]] = []


def check(ok: bool, label: str, detail: str = "") -> None:
    results.append((bool(ok), label))
    print(f"{'PASS' if ok else 'FAIL'}  {label}" + (f"  [{detail}]" if detail else ""))


def main() -> int:
    try:
        import accelerate
        import numpy
        import peft
        import torch
        import transformers
    except Exception as exc:  # noqa: BLE001 - report, do not traceback
        print(f"FAIL  imports: {type(exc).__name__}: {exc}")
        return 1

    installed = {
        "torch": torch.__version__.split("+")[0],
        "transformers": transformers.__version__,
        "peft": peft.__version__,
        "accelerate": accelerate.__version__,
        "numpy": numpy.__version__,
    }
    for name, expected in EXPECTED.items():
        check(installed[name] == expected, f"{name}=={expected}", installed[name])

    # The model card's loading contract, exactly as ultravox_engine.py calls it.
    params = inspect.signature(transformers.pipeline).parameters
    for kwarg in ("torch_dtype", "device", "trust_remote_code"):
        check(kwarg in params, f"transformers.pipeline accepts {kwarg}")

    # pipeline(model="<id>") must be able to infer the checkpoint's custom task.
    pipelines_source = inspect.getsource(transformers.pipelines)
    check(
        "custom_pipelines" in pipelines_source,
        "transformers supports config.custom_pipelines tasks",
    )

    # The checkpoint's ultravox_model.py reads this module-level flag.
    from transformers import modeling_utils

    check(
        isinstance(getattr(modeling_utils, "_init_weights", None), bool),
        "transformers.modeling_utils._init_weights exists",
    )

    # peft/accelerate symbols the checkpoint imports unconditionally.
    check(hasattr(peft, "LoraConfig") and hasattr(peft, "get_peft_model"),
          "peft.LoraConfig/get_peft_model")
    check(hasattr(accelerate, "init_empty_weights"), "accelerate.init_empty_weights")

    # Gated-backbone auth: the checkpoint forwards no token, so the environment
    # token must reach huggingface_hub's request headers.
    from huggingface_hub.utils import build_hf_headers

    saved = {k: os.environ.pop(k, None) for k in ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN")}
    try:
        check(
            "authorization" not in build_hf_headers(token=None),
            "no HF token -> no Authorization header",
        )
    finally:
        for key, value in saved.items():
            if value is not None:
                os.environ[key] = value

    env_token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
    if env_token:
        headers = build_hf_headers(token=None)
        check(
            headers.get("authorization", "").startswith("Bearer "),
            "HF_TOKEN is attached to hub requests",
        )
    else:
        check(False, "HF_TOKEN is set", "required for meta-llama/Llama-3.1-8B-Instruct")

    if torch.cuda.is_available():
        print(
            f"INFO  cuda device: {torch.cuda.get_device_name(0)} "
            f"({torch.cuda.get_device_properties(0).total_memory / 1024**3:.1f} GiB)"
        )
    else:
        print("INFO  cuda unavailable (expected on a laptop/CPU check)")

    failed = [label for ok, label in results if not ok]
    print()
    if failed:
        print(f"{len(failed)} check(s) failed: {', '.join(failed)}")
        return 1
    print(f"All {len(results)} checks passed.")
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
