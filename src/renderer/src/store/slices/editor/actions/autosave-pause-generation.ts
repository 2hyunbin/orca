let autosavePauseGeneration = 0

// Why: fixed so every restore of one session builds identical state; live pauses start at 1.
export const RESTORED_AUTOSAVE_PAUSE_GENERATION = 0

/** Process-wide so two pauses can never share a generation. */
export function nextAutosavePauseGeneration(): number {
  autosavePauseGeneration += 1
  return autosavePauseGeneration
}
