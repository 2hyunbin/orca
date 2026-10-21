import { ProviderCleanupBudget } from '../provider-process/provider-process-exit-deadline'
import { discoverProviderLaunches } from '../provider-process/provider-process-inventory'
import { verifyRecoveredProviderResources } from '../provider-process/provider-process-ledger'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'

// Why: Codex OAuth uses rotating refresh tokens stored in each home's auth.json.
// Two Orca-spawned codex processes refreshing the same home concurrently can
// consume one rotation twice and permanently invalidate the stored credential,
// so Orca's own spawns (quota probes, commit-message runs) serialize per home.
// User terminal panes are intentionally not serialized here.

const retainedWriters = new Map<string, Set<(budget: ProviderCleanupBudget) => Promise<boolean>>>()

export function retainCodexHomeWriter(
  key: string,
  verify: (budget: ProviderCleanupBudget) => Promise<boolean>
): void {
  let writers = retainedWriters.get(key)
  if (!writers) {
    writers = new Set()
    retainedWriters.set(key, writers)
  }
  writers.add(verify)
}

async function verifyCodexHomeWriters(key: string): Promise<void> {
  const discovered = await discoverProviderLaunches(new ProviderCleanupBudget(Date.now() + 2_000))
  const budget = new ProviderCleanupBudget()
  const writers = retainedWriters.get(key) ?? new Set()
  for (const verify of writers) {
    if (budget.active && (await budget.wait(verify(budget), false))) {
      writers.delete(verify)
    }
  }
  if (discovered && (await verifyRecoveredProviderResources(key, budget)) && writers.size === 0) {
    retainedWriters.delete(key)
  } else {
    throw new Error(
      'Codex is still using this account home. Try again after its previous command stops.'
    )
  }
}

const lockTails = new Map<string, Promise<unknown>>()

export function resolveCodexHomeProcessLockKey(codexHomePath?: string | null): string {
  const home = codexHomePath ?? process.env.CODEX_HOME ?? join(homedir(), '.codex')
  return normalizeRuntimePathForComparison(home)
}

export function resolveCodexHomeProcessLockKeyForSpawnEnv(
  env: NodeJS.ProcessEnv | undefined,
  wslDistro?: string | null,
  commandEnv?: Record<string, string>
): string {
  if (wslDistro) {
    // buildWslLauncherEnv forwards only explicit values that differ from the
    // host process; all other cases use the distro user's default home.
    const codexHome =
      commandEnv?.CODEX_HOME ??
      (env?.CODEX_HOME !== process.env.CODEX_HOME ? (env?.CODEX_HOME ?? null) : null)
    // Why: WSL spawns carry a Linux CODEX_HOME; key it through the same UNC
    // normalization the probe's \\wsl$ home path uses so both lanes collide.
    // Without an explicit home the distro default is unknowable from the host;
    // a sentinel still serializes same-distro default spawns with each other.
    return normalizeRuntimePathForComparison(
      `//wsl$/${wslDistro}${codexHome ?? '/.orca-default-codex-home'}`
    )
  }
  // An explicit env is the child's complete environment. If CODEX_HOME was
  // deliberately stripped, the child uses ~/.codex regardless of our ambient env.
  const codexHome = env === undefined ? process.env.CODEX_HOME : env.CODEX_HOME
  return normalizeRuntimePathForComparison(codexHome ?? join(homedir(), '.codex'))
}

export function withCodexHomeProcessLock<T>(lockKey: string, fn: () => Promise<T>): Promise<T> {
  const prior = lockTails.get(lockKey) ?? Promise.resolve()
  const run = prior.then(async () => {
    await verifyCodexHomeWriters(lockKey)
    return fn()
  })
  // Why: keep the queue alive past a failed run so later entrants still start.
  const tail = run.then(
    () => undefined,
    () => undefined
  )
  lockTails.set(lockKey, tail)
  void tail.then(() => {
    if (lockTails.get(lockKey) === tail) {
      lockTails.delete(lockKey)
    }
  })
  return run
}
