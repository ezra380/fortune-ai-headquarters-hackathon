#!/usr/bin/env bash
# Fetches the Meterless open engines (Apache-2.0) at the pinned commit into .local/meterless.
set -euo pipefail
PIN=1742dec56a66e58eef9dda2d2b865823758ca8cd
DIR="${METERLESS_DIR:-.local/meterless}"
if [ ! -d "$DIR/.git" ]; then
  git clone --no-checkout https://github.com/Meterless/Meterless.git "$DIR"
fi
git -C "$DIR" fetch --quiet origin "$PIN" 2>/dev/null || true
git -C "$DIR" checkout --quiet --detach "$PIN"
echo "Meterless engines at $(git -C "$DIR" rev-parse --short HEAD) in $DIR"
