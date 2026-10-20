import { realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { AiVaultListResult, AiVaultSession } from '../../shared/ai-vault-types'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison,
  relativePathInsideRoot
} from '../../shared/cross-platform-path'
import { sessionFileExecutionNamespace } from '../../shared/ai-vault-scope-cwd-match'
import { parseWslUncPath } from '../../shared/wsl-paths'

/** A scope path registered through a symlink, and where it really points on this host. */
type AiVaultScopeLink = { scopePath: string; realPath: string }

export type AiVaultScopeRealPaths = {
  /** The registered paths plus their real paths, so the scan admits sessions recorded under either. */
  scanScopePaths: readonly string[]
  links: readonly AiVaultScopeLink[]
}

/**
 * Why here: this runs on the host that owns the files (the desktop for local
 * scans, orcad for SSH and server hosts), so a symlink resolves against the
 * disk the agents actually wrote their cwd on.
 */
export async function resolveAiVaultScopeRealPaths(
  scopePaths: readonly string[]
): Promise<AiVaultScopeRealPaths> {
  const links: AiVaultScopeLink[] = []
  for (const scopePath of scopePaths) {
    // Why skip WSL UNC paths: Windows cannot resolve a Linux symlink through the share.
    if (!isAbsolute(scopePath) || parseWslUncPath(scopePath)) {
      continue
    }
    // A path missing on this host belongs to another host's workspace; it stays unmatched.
    const realPath = await realpath(scopePath).catch(() => null)
    if (realPath && !sameComparisonPath(realPath, scopePath)) {
      links.push({ scopePath, realPath })
    }
  }
  const scanScopePaths = [...scopePaths]
  for (const { realPath } of links) {
    if (!scanScopePaths.some((path) => sameComparisonPath(path, realPath))) {
      scanScopePaths.push(realPath)
    }
  }
  return { scanScopePaths, links }
}

/**
 * Gives each session recorded under a linked scope's real path the registered
 * spelling as a matching-only alias. Resume keeps reading the recorded `cwd`.
 */
export async function attachAiVaultScopeCwdAliases(
  result: AiVaultListResult,
  scope: AiVaultScopeRealPaths
): Promise<AiVaultListResult> {
  if (scope.links.length === 0) {
    return result
  }
  const resolveCwd = createLooseRealPathResolver()
  const aliasesByCwd = new Map<string, string[]>()
  let changed = false
  const sessions: AiVaultSession[] = []
  for (const session of result.sessions) {
    const cwd = session.cwd
    // Why native only: WSL rows carry Linux cwds this Windows host cannot resolve.
    if (!cwd || !isAbsolute(cwd) || sessionFileExecutionNamespace(session.filePath) !== 'native') {
      sessions.push(session)
      continue
    }
    let aliases = aliasesByCwd.get(cwd)
    if (!aliases) {
      aliases = scopeAliasesFor(cwd, scope.links)
      // A cwd recorded through another symlink only matches once it is resolved too.
      if (
        aliases.length === 0 &&
        !scope.scanScopePaths.some((scopePath) => isPathInsideOrEqual(scopePath, cwd))
      ) {
        aliases = scopeAliasesFor(await resolveCwd(cwd), scope.links)
      }
      aliasesByCwd.set(cwd, aliases)
    }
    if (aliases.length === 0) {
      sessions.push(session)
      continue
    }
    changed = true
    sessions.push({ ...session, cwdAliases: aliases })
  }
  return changed ? { ...result, sessions } : result
}

function scopeAliasesFor(cwd: string, links: readonly AiVaultScopeLink[]): string[] {
  const aliases: string[] = []
  for (const { scopePath, realPath } of links) {
    const suffix = relativePathInsideRoot(realPath, cwd)
    if (suffix !== null) {
      aliases.push(suffix ? join(scopePath, suffix) : scopePath)
    }
  }
  return aliases
}

/** realpath of the deepest existing ancestor plus the rest, so a deleted cwd still resolves. */
function createLooseRealPathResolver(): (path: string) => Promise<string> {
  const cache = new Map<string, Promise<string>>()
  const resolve = (path: string): Promise<string> => {
    let pending = cache.get(path)
    if (!pending) {
      pending = realpath(path).catch(async () => {
        const parent = dirname(path)
        return parent === path ? path : join(await resolve(parent), basename(path))
      })
      cache.set(path, pending)
    }
    return pending
  }
  return resolve
}

function sameComparisonPath(left: string, right: string): boolean {
  return normalizeRuntimePathForComparison(left) === normalizeRuntimePathForComparison(right)
}
