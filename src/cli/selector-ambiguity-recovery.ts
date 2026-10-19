// Why: the runtime answers a selector that matches several rows (two projects both named `app`)
// with a bare `selector_ambiguous`, naming neither the value nor a way out. Only the CLI still
// knows which flag the caller typed, so it says which selector was ambiguous and what is exact.

export type SelectorAmbiguityRecovery = {
  ambiguousSelectors: { flag: string; selector: string }[]
  nextSteps: readonly string[]
}

const EXACT_FORMS = {
  repo: {
    forms: 'id:<repo-id> or path:<absolute-path>',
    list: 'orca repo list --json',
    noun: 'project'
  },
  worktree: {
    // Why identity first: a local and an SSH checkout can share both repo id and path.
    forms:
      'identity:<identity.key> (host-qualified), or id:<repo-id>::<absolute-path> when only one host has that checkout',
    list: 'orca worktree list --json',
    noun: 'workspace'
  }
} as const

export function selectorAmbiguityRecovery(selectors: {
  repo?: string
  worktree?: string
}): SelectorAmbiguityRecovery | undefined {
  const entries = (['worktree', 'repo'] as const).flatMap((flag) => {
    const selector = selectors[flag]
    return selector ? [{ flag, selector }] : []
  })
  if (entries.length === 0) {
    return undefined
  }
  return {
    ambiguousSelectors: entries.map(({ flag, selector }) => ({ flag: `--${flag}`, selector })),
    nextSteps: entries.flatMap(({ flag, selector }) => {
      const exact = EXACT_FORMS[flag]
      // Both flags given: the runtime does not say which one matched several rows.
      const matched =
        entries.length > 1
          ? `--${flag} "${selector}" may match more than one ${exact.noun}.`
          : `More than one ${exact.noun} matches --${flag} "${selector}".`
      return [
        `${matched} Pass an exact selector: ${exact.forms}.`,
        `List the exact values with \`${exact.list}\`.`
      ]
    })
  }
}
