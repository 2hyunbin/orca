let autosavePauseGeneration = 0

/** Process-wide so a restored pause and a new one can never share a generation. */
export function nextAutosavePauseGeneration(): number {
  autosavePauseGeneration += 1
  return autosavePauseGeneration
}
