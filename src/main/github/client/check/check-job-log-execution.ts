import { normalizeGhAccountBinding } from '../../../../shared/github/account-binding'
import { parseWslUncPath } from '../../../../shared/wsl-paths'
import { githubReadExecutionScope } from '../../github-read-execution-scope'
import { addWslEnvKeys } from '../../../../shared/wsl-env'
import { stripAmbientGhTokenEnv } from '../../gh-ambient-token-env'
import type { GitHubApiRepository } from '../../github-api-repository'
import type { GhExecOptions } from '../github-exec-scope'
import { ghExecFileAsync, ghExecFileWithScopeAsync } from '../../gh-utils'
import { runCheckDetailsCall } from './check-details-admission-lifetime'
import { waitForCheckDetailsResolution } from './check-details-abort'
import { assertCheckLogActive } from './check-job-log-download'

function reusableHost(host: string): 'cloud' | 'enterprise' | null {
  if (!/^[a-z0-9][a-z0-9.-]*(?::\d+)?$/.test(host)) {
    return null
  }
  if (host === 'github.com' || host === 'github.localhost') {
    return 'cloud'
  }
  const name = host.split(':')[0]
  if (
    ['github.com', 'github.localhost', 'ghe.com'].some(
      (base) => name === base || name.endsWith(`.${base}`)
    )
  ) {
    return null
  }
  return 'enterprise'
}

function reusableRuntime(options: GhExecOptions): boolean {
  return (
    process.platform !== 'win32' ||
    Boolean(options.cwd && !options.wslDistro && !parseWslUncPath(options.cwd))
  )
}

export function snapshotCheckJobLogExecution(
  ownerRepo: GitHubApiRepository,
  options: GhExecOptions,
  resolvedRuntimeScope?: string
): { ghOptions: GhExecOptions; executionScope: string | null } {
  const host = (ownerRepo.host ?? 'github.com').trim().toLowerCase()
  if (options.host !== undefined && options.host.trim().toLowerCase() !== host) {
    throw new Error('GitHub check details host is unavailable.')
  }
  const binding = normalizeGhAccountBinding(options.ghAccount)
  const env: NodeJS.ProcessEnv = Object.freeze({
    ...(options.env ?? process.env),
    GH_PROMPT_DISABLED: (options.env ?? process.env).GH_PROMPT_DISABLED ?? '1'
  })
  const ghAccount = binding
    ? Object.freeze({ host: binding.host, user: binding.user })
    : options.ghAccount
      ? Object.freeze({ ...options.ghAccount })
      : undefined
  const ghOptions = Object.freeze({ ...options, host, env, ...(ghAccount ? { ghAccount } : {}) })
  const family = reusableHost(host)
  const bound = Boolean(binding && binding.host === host)
  const token =
    family === 'cloud'
      ? env.GH_TOKEN || env.GITHUB_TOKEN
      : env.GH_ENTERPRISE_TOKEN || env.GITHUB_ENTERPRISE_TOKEN
  if (
    (!resolvedRuntimeScope && !reusableRuntime(options)) ||
    !family ||
    (options.ghAccount ? !bound : !token)
  ) {
    return { ghOptions, executionScope: null }
  }
  const projection = {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    encoding: options.encoding ?? 'utf-8',
    ...(options.wslDistro === undefined ? {} : { wslDistro: options.wslDistro }),
    host,
    ...(resolvedRuntimeScope ? { resolvedRuntimeScope } : {}),
    ...(binding ? { ghAccount: { host: binding.host, user: binding.user } } : {})
  }
  return { ghOptions, executionScope: githubReadExecutionScope(projection, env) }
}

export async function resolveCheckJobLogCredentials(
  ownerRepo: GitHubApiRepository,
  options: GhExecOptions & { signal: AbortSignal },
  deadlineAt: number,
  retainUntil: (terminated: Promise<void>) => void
): Promise<ReturnType<typeof snapshotCheckJobLogExecution>> {
  const snapshot = snapshotCheckJobLogExecution(ownerRepo, options)
  const host = snapshot.ghOptions.host ?? 'github.com'
  const family = reusableHost(host)
  const uncertainRuntime = !reusableRuntime(options)
  const binding = normalizeGhAccountBinding(options.ghAccount)
  if (
    snapshot.executionScope ||
    !family ||
    (options.ghAccount && (!uncertainRuntime || !binding || binding.host !== host))
  ) {
    return snapshot
  }
  // Read each batch's active keyring token, then pin it so account switches cannot cross the cache.
  const call = runCheckDetailsCall<{
    stdout: string
    stderr: string
    rateLimitScope?: string
  }>(
    (hooks) => {
      assertCheckLogActive(options.signal, deadlineAt)
      const run = uncertainRuntime ? ghExecFileWithScopeAsync : ghExecFileAsync
      return run(
        ['auth', 'token', '--hostname', host, ...(binding ? ['--user', binding.user] : [])],
        {
          ...snapshot.ghOptions,
          ...(binding ? { env: stripAmbientGhTokenEnv(snapshot.ghOptions.env ?? {}) } : {}),
          timeout: deadlineAt - Date.now(),
          maxBuffer: 16 * 1024
        },
        hooks
      )
    },
    options.signal,
    retainUntil
  )
  try {
    const { stdout, rateLimitScope } = await call.result.finally(() =>
      waitForCheckDetailsResolution(call.terminated, options.signal)
    )
    const token = stdout.trim()
    if (!token || /\s/.test(token)) {
      return snapshot
    }
    const tokenVariable = family === 'cloud' ? 'GH_TOKEN' : 'GH_ENTERPRISE_TOKEN'
    const env = {
      ...snapshot.ghOptions.env,
      [tokenVariable]: token
    }
    // A later WSL/native fallback must keep the token resolved for this batch.
    if (uncertainRuntime) {
      const keys = [tokenVariable, 'GH_PROMPT_DISABLED']
      // WSLENV flags must not transform or block the pinned credentials.
      env.WSLENV = (env.WSLENV ?? '')
        .split(':')
        .filter((entry) => !keys.includes(entry.split('/')[0]))
        .join(':')
      addWslEnvKeys(env, keys)
    }
    const { ghAccount: _account, ...pinnedOptions } = snapshot.ghOptions
    return snapshotCheckJobLogExecution(
      ownerRepo,
      { ...pinnedOptions, env },
      rateLimitScope ? JSON.stringify([rateLimitScope, binding]) : undefined
    )
  } catch {
    assertCheckLogActive(options.signal, deadlineAt)
    return snapshot
  }
}
