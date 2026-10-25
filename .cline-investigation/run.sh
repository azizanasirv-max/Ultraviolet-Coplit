#!/bin/bash
cd /workspace
L=$(find .browser-libs/root -name '*.so*' -printf '%h\n' | sort -u | tr '\n' ':')
export LD_LIBRARY_PATH="$L"
export FONTCONFIG_FILE=/workspace/.browser-libs/fonts.conf
export SCENARIO="${1:-direct}"
export SUFFIX="${2:-}"
export INTERCEPT_ICE="${INTERCEPT_ICE:-0}"
export BROWSER_ARGS="${BROWSER_ARGS:-}"
node --import tsx .cline-investigation/run-ice-probe.ts
