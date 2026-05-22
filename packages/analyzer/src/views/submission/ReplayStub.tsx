/**
 * Replay tab — placeholder.
 *
 * Phase 23 ships Timeline as the working second tab.
 * Replay (Monaco + scrubbing + content/provenance) is Phase 25 polish.
 */

export function ReplayStub() {
  return (
    <div className="container mx-auto py-12 text-center text-gray-400" data-testid="replay-stub">
      <p className="text-lg font-medium">Replay — Coming in next sprint</p>
      <p className="text-sm mt-2">
        The Monaco-based replay with scrubbing and per-character provenance is Phase 25.
      </p>
    </div>
  );
}
