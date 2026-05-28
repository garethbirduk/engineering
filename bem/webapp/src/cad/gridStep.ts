// Picks a grid spacing that yields ~15 grid lines across the visible viewport,
// snapped to {1, 2, 5} × 10^k so the user sees friendly round numbers.
// Used by both the Grid renderer and the snap utility so they stay in sync.

export function gridStepForViewWidth(viewWidth: number): number {
  if (!Number.isFinite(viewWidth) || viewWidth <= 0) {
    throw new Error(`gridStepForViewWidth: invalid width ${viewWidth}`);
  }
  const target = viewWidth / 15;
  const pow = Math.pow(10, Math.floor(Math.log10(target)));
  const ratio = target / pow;
  return pow * (ratio < 1.5 ? 1 : ratio < 3.5 ? 2 : ratio < 7.5 ? 5 : 10);
}
