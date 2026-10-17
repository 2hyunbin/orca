import { createAiVaultScopeCwdMatcher } from '../../shared/ai-vault-scope-cwd-match'

/**
 * A scoped list reads every row's `directory` and keeps the newest `limit` in
 * scope, so the scope applies before the cap. A schema without the column cannot
 * say, so its rows stay candidates and the parsed cwd decides.
 */
export function scopedSessionRows<Row extends { directory?: unknown }>(
  rows: readonly Row[],
  scopePaths: readonly string[],
  limit: number
): Row[] {
  const inScope = createAiVaultScopeCwdMatcher(scopePaths)
  const matching = rows.filter(
    (row) =>
      !('directory' in row) || inScope(typeof row.directory === 'string' ? row.directory : null)
  )
  return Number.isFinite(limit) ? matching.slice(0, limit) : matching
}
