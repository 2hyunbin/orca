import {
  createNormalizedPathInsideOrEqualMatcher,
  normalizeRuntimePathForComparison
} from './cross-platform-path'
import { parseWslUncPath } from './wsl-paths'

/**
 * Whether a session's cwd belongs to a Workspace or Project scope. The scan that
 * finds older in-scope sessions and the cached-list truncation that keeps them
 * share this one rule, so a row the scan recovered is never trimmed again.
 */
export function createAiVaultScopeCwdMatcher(
  scopePaths: readonly string[]
): (cwd: string | null | undefined) => boolean {
  const matchers = scopePaths.flatMap((scopePath) => {
    // WSL transcripts record Linux cwds even when the scope is the worktree's UNC path.
    const wslScopePath = parseWslUncPath(scopePath)
    return (wslScopePath ? [scopePath, wslScopePath.linuxPath] : [scopePath]).map(
      createNormalizedPathInsideOrEqualMatcher
    )
  })
  return (cwd) => {
    if (!cwd || matchers.length === 0) {
      return false
    }
    const normalized = normalizeRuntimePathForComparison(cwd)
    return matchers.some((matches) => matches(normalized))
  }
}
