#!/usr/bin/env bash
# Pre-download Qwen3.5-9B from HuggingFace so the vLLM container starts fast.
# Uses the HF_TOKEN from ../vllm/.env for authenticated (faster) transfer.
#
# Usage:
#   ./download-scout-model.sh
#
# One-time cost: ~18 GB (BF16 weights). vLLM quantizes to FP8 at load time,
# so runtime VRAM is ~12 GB despite the full-precision download.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../vllm/.env"

# Load HF_TOKEN from .env
if [[ -f "$ENV_FILE" ]]; then
    set -a; source "$ENV_FILE"; set +a
    echo "✓ HF_TOKEN loaded from $ENV_FILE"
else
    echo "⚠ $ENV_FILE not found — download will be unauthenticated (slower)"
fi

MODEL="Qwen/Qwen3.5-9B"
CACHE_DIR="$HOME/.cache/huggingface"

echo ""
echo "Downloading $MODEL to $CACHE_DIR ..."
echo "(~18 GB BF16 weights — vLLM quantizes to FP8 at load time)"
echo ""

huggingface-cli download "$MODEL" --cache-dir "$CACHE_DIR"

echo ""
echo "✓ Download complete."
echo "  Cache: $CACHE_DIR"
echo ""
echo "You can now start the stack:"
echo "  docker compose -f gpu-stack-vllm.yml up -d"
