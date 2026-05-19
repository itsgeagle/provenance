#!/usr/bin/env bash
# Preview the analyzer with the test fixture.
# Checks for the fixture file, starts the dev server, and displays instructions.
# Usage: scripts/preview-fixture.sh

set -euo pipefail

FIXTURE_PATH="packages/analyzer/test/fixtures/sample-bundle.zip"

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

# Start the dev server in the background
echo "Starting analyzer dev server..."
npm run dev --workspace=packages/analyzer &
DEV_PID=$!

# Wait for the dev server to be ready
sleep 3

# Print instructions
cat <<EOF
✓ Dev server started (PID $DEV_PID)

To test the analyzer with the fixture:

  1. Open http://localhost:5173 in your browser
  2. On the Load page, drop or select: $FIXTURE_PATH
  3. Review the Overview dashboard, validation report, and timeline

To stop the server, press Ctrl+C or run:
  kill $DEV_PID

EOF

# Keep the script alive and forward signals
wait $DEV_PID
