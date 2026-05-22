/**
 * Validation tab — placeholder.
 *
 * The detailed validation panel is covered by the Overview tab's validation
 * summary section for Phase 23. A full dedicated tab is Phase 24/25.
 */

export function ValidationStub() {
  return (
    <div
      className="container mx-auto py-12 text-center text-gray-400"
      data-testid="validation-stub"
    >
      <p className="text-lg font-medium">Validation — See Overview tab</p>
      <p className="text-sm mt-2">
        Full validation detail view is Phase 24. The Overview tab shows the summary.
      </p>
    </div>
  );
}
