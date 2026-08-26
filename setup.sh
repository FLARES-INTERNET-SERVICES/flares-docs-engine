#!/usr/bin/env bash
#
# Build this repository from a clean clone.
#
# It does not build from a plain `git clone`, and rather than leave that to be
# rediscovered, this does the two things that are missing:
#
#   1. `docx-editor/vendor/design-system` is declared as a submodule with an
#      SSH URL (git@github.com:...). Anyone without a key on that account gets
#      an empty directory and a build that fails on an unresolved
#      `@schnsrw/design-system` import. The repository IS public over HTTPS, so
#      rewriting the URL for this one command is enough — and is scoped here
#      rather than written into anyone's global git config.
#
#   2. `katex` is imported by the editor but not pulled in by the workspace
#      resolve, so Vite's dependency scan fails without it.
#
# Usage:
#   ./setup.sh              install and build
#   ./setup.sh --dev        the above, then start the dev server
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

say() { printf '\n\033[1;37m== %s\033[0m\n' "$1"; }

say "Submodules"
git -c url."https://github.com/".insteadOf="git@github.com:" \
    submodule update --init --recursive
echo "  design-system: $(ls docx-editor/vendor/design-system 2>/dev/null | wc -l) entries"

command -v bun >/dev/null 2>&1 || {
    echo "bun is required — see https://bun.sh (or: npm i -g bun)"
    exit 1
}

say "Dependencies"
cd docx-editor
bun install
[ -d node_modules/katex ] || bun add -d katex

say "Collaboration backend"
if [ ! -f examples/vite/.env.local ]; then
    cat > examples/vite/.env.local <<'ENV'
VITE_COLLAB_ENABLED=true
VITE_COLLAB_BACKEND=ws://localhost:8080/yjs
ENV
    echo "  wrote examples/vite/.env.local"
else
    echo "  examples/vite/.env.local already present, left alone"
fi

say "Build"
bun run build:demo

say "Done"
cat <<EOF
  Built: docx-editor/examples/vite/dist

  Run it:
    docker compose up -d redis app     # collaboration server + Redis
    cd docx-editor && bun run dev      # editor on :5173

  Measure performance against the production build, not the dev server:
    cd docx-editor && bun run build:demo
    npx serve -s examples/vite/dist -l 5196
EOF

if [ "${1:-}" = "--dev" ]; then
    say "Starting the dev server"
    bun run dev
fi
