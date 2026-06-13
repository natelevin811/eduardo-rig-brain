#!/usr/bin/env bash
# Install the repo's git hooks by pointing core.hooksPath at .githooks.
# Idempotent. Run from anywhere inside the repo.
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
chmod +x "$root/.githooks/pre-commit"
git -C "$root" config core.hooksPath .githooks
echo "installed: core.hooksPath -> .githooks"
echo "the pre-commit hook now runs the Set Linter on staged *.als (and on any"
echo "path in \$RIG_LINT_SET or .riglintset). Bypass once with: git commit --no-verify"
