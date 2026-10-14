#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
FRAMEWORK_DIR="$PWD/.local/delegation-framework"
REVISION=bff4b08f8006ad94322a6e3da8d90f274e20325d
if [ ! -d "$FRAMEWORK_DIR/.git" ]; then
  git clone --filter=blob:none --no-checkout https://github.com/MetaMask/delegation-framework.git "$FRAMEWORK_DIR"
fi
git -C "$FRAMEWORK_DIR" checkout "$REVISION"
git -C "$FRAMEWORK_DIR" submodule update --init --recursive --depth=1
forge build --root "$FRAMEWORK_DIR" --skip test --skip script
