let revision = 0

/** Orders accepted review lookups on this renderer, independent of execution-host clocks. */
export function nextReviewLookupRevision(): number {
  revision += 1
  return revision
}
