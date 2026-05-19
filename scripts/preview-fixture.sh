#!/usr/bin/env bash
# Preview the analyzer with the test fixture.
# Checks for the fixture file, starts the dev server, and displays instructions.
# Usage: scripts/preview-fixture.sh

set -euo pipefail

FIXTURE_PATH="packages/analyzer/test/fixtures/sample-bundle.zip"
DEV_PID=""

if [ ! -f "$FIXTURE_PATH" ]; then
  cat >&2 <<'EOF'
Error: test fixture not found at packages/analyzer/test/fixtures/sample-bundle.zip

To regenerate the fixture, see:
  packages/analyzer/test/integration/regenerate-fixture.md

Steps:
  1. Build and install the recorder VSIX:
     npm run package:recorder

  2. Open test-workspace in VS Code and do some editing (type, paste, save)

  3. Run: Provenance: Prepare Submission Bundle (via VS Code command palette)

  4. Copy the resulting .zip to packages/analyzer/test/fixtures/sample-bundle.zip

  5. Commit it:
     git add packages/analyzer/test/fixtures/sample-bundle.zip
     git commit -m "test: update real-recorder fixture"

EOF
  exit 1
fi

# Cleanup function: kill the dev server if script exits or user presses Ctrl+C
cleanup() {
  if [ -n "$DEV_PID" ] && kill -0 "$DEV_PID" 2>/dev/null; then
    echo "Stopping dev server (PID $DEV_PID)..."
    kill "$DEV_PID" 2>/dev/null || true
    wait "$DEV_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# Start the dev server in the background
echo "Starting analyzer dev server..."
npm run dev --workspace=packages/analyzer &
DEV_PID=$!

# Wait for the dev server to be ready (poll for port 5173)
for i in {1..30}; do
  if nc -z localhost 5173 2>/dev/null; then
    break
  fi
  sleep 0.5
done

# Print instructions
cat <<EOF
[OK] Dev server started (PID $DEV_PID)

To test the analyzer with the fixture:

  1. Open http://localhost:5173 in your browser
  2. On the Load page, drop or select: $FIXTURE_PATH
  3. Review the Overview dashboard, validation report, and timeline

Press Ctrl+C to stop the server.

EOF

# Keep the script alive and forward signals
wait "$DEV_PID"
