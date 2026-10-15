import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import path, { isAbsolute, join, posix, resolve } from 'node:path'
import { SKILL_INSTALL_PROVIDERS } from '../../shared/skill-install-providers'
import { buildWslCapturedLoginShellCommand } from '../../shared/wsl-login-shell-command'
import { toWindowsWslPath } from '../../shared/wsl-paths'
import { runWslProcess } from '../wsl/wsl-runner'
import type { SkillProviderRootOverrides } from './skill-provider-destinations'

const PROVIDER_ROOT_MAX_LENGTH = 32_768
const WSL_ENV_PROBE_TIMEOUT_MS = 8_000
const WSL_ENV_PROBE_VALUE_MAX_LENGTH = 4_096
// Room for rc output ahead of the fence; a clipped fence reads as a failed probe.
const WSL_ENV_PROBE_MAX_BYTES = 65_536
const PROVIDER_HOME_ENVS = SKILL_INSTALL_PROVIDERS.flatMap((provider) =>
  provider.homeEnv ? [{ id: provider.id, name: provider.homeEnv }] : []
)
// Why $HOME first: unusable homes are judged against the guest's own home.
const WSL_PROVIDER_HOMES_PROBE = buildWslCapturedLoginShellCommand(
  `printf '%s\\0' "$HOME" ${PROVIDER_HOME_ENVS.map(({ name }) => `"\${${name}:-}"`).join(' ')}`
)

type HomePathApi = Pick<typeof posix, 'dirname' | 'isAbsolute' | 'relative' | 'sep'>

/**
 * Like Kiro's documented rule: the filesystem root, the user home and its
 * ancestors fall back to the default, since `<home>/skills` there is unrelated.
 */
function isUsableProviderHome(candidate: string, userHome: string, pathApi: HomePathApi): boolean {
  if (pathApi.dirname(candidate) === candidate) {
    return false
  }
  const toUserHome = pathApi.relative(candidate, userHome)
  return (
    toUserHome === '..' ||
    toUserHome.startsWith(`..${pathApi.sep}`) ||
    pathApi.isAbsolute(toUserHome)
  )
}

function normalizedRoot(value: string | undefined): string | null {
  const candidate = value?.trim()
  if (
    !candidate ||
    candidate.length > PROVIDER_ROOT_MAX_LENGTH ||
    candidate.includes('\0') ||
    !isAbsolute(candidate)
  ) {
    return null
  }
  return resolve(candidate)
}

export function resolveEnvironmentSkillProviderRoots(
  env: NodeJS.ProcessEnv = process.env,
  userHome: string = homedir()
): SkillProviderRootOverrides {
  const roots: SkillProviderRootOverrides = {}
  for (const provider of SKILL_INSTALL_PROVIDERS) {
    const home = provider.homeEnv ? normalizedRoot(env[provider.homeEnv]) : null
    if (home && isUsableProviderHome(home, resolve(userHome), path)) {
      roots[provider.id] = join(home, 'skills')
    }
  }
  return roots
}

// Why: `HERMES_HOME` relocates a whole Hermes profile tree (`hermes -p coder`),
// and the rest of Orca already treats it as authoritative. Hermes is not an
// install provider, so it stays out of `SkillProviderRootOverrides`.
export function resolveEnvironmentHermesSkillsRoot(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const hermesHome = normalizedRoot(env.HERMES_HOME)
  return hermesHome ? join(hermesHome, 'skills') : null
}

function isExistingDirectory(candidate: string): boolean {
  return statSync(candidate, { throwIfNoEntry: false })?.isDirectory() === true
}

/**
 * The Hermes home when `HERMES_HOME` is unset. Windows installs land in
 * `%LOCALAPPDATA%\hermes`, not a dotfolder in the user profile, so the POSIX
 * `~/.hermes` default discovers nothing there. The dotfolder still wins on
 * Windows when it exists and the LOCALAPPDATA tree does not, which is the
 * pre-LOCALAPPDATA install Hermes itself keeps honouring rather than orphaning.
 */
export function resolveDefaultHermesSkillsRoot(input: {
  homeDir: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  directoryExists?: (candidate: string) => boolean
}): string {
  const dotfolderHome = join(input.homeDir, '.hermes')
  if ((input.platform ?? process.platform) !== 'win32') {
    return join(dotfolderHome, 'skills')
  }
  const localAppData = normalizedRoot((input.env ?? process.env).LOCALAPPDATA)
  if (!localAppData) {
    return join(dotfolderHome, 'skills')
  }
  const localAppDataHome = join(localAppData, 'hermes')
  const directoryExists = input.directoryExists ?? isExistingDirectory
  return !directoryExists(localAppDataHome) && directoryExists(dotfolderHome)
    ? join(dotfolderHome, 'skills')
    : join(localAppDataHome, 'skills')
}

export function withClaudeSkillProviderRoot(
  roots: SkillProviderRootOverrides,
  claudeConfigDirectory: string | null | undefined
): SkillProviderRootOverrides {
  const configDirectory = normalizedRoot(claudeConfigDirectory ?? undefined)
  return configDirectory ? { ...roots, claude: join(configDirectory, 'skills') } : roots
}

/** The fenced payload, or null when the probe failed or the fence was lost. */
type WslEnvironmentProbe = (distro: string) => Promise<string | null>

async function probeWslProviderHomes(distro: string): Promise<string | null> {
  const result = await runWslProcess({
    distro,
    // 'none': the fenced command runs its own login shell, so a runner probe
    // would buy a second one out of the same 8s budget.
    loginPath: 'none',
    script: WSL_PROVIDER_HOMES_PROBE.command,
    shell: 'sh',
    timeoutMs: WSL_ENV_PROBE_TIMEOUT_MS,
    maxOutputBytes: WSL_ENV_PROBE_MAX_BYTES
  })
  if (result.code !== 0 || result.timedOut) {
    return null
  }
  return WSL_PROVIDER_HOMES_PROBE.readStdout(result.stdout)
}

function wslProviderHome(value: string, userHome: string): string | null {
  const candidate = value.trim()
  if (
    !candidate ||
    candidate.length > WSL_ENV_PROBE_VALUE_MAX_LENGTH ||
    !candidate.startsWith('/') ||
    candidate.includes('\\') ||
    Array.from(candidate).some((character) => {
      const code = character.charCodeAt(0)
      return code <= 0x1f || code === 0x7f
    })
  ) {
    return null
  }
  const home = posix.resolve(candidate)
  return isUsableProviderHome(home, posix.resolve('/', userHome), posix) ? home : null
}

/** Every table `homeEnv` as the WSL login shell sees it, read in one probe. */
export async function resolveWslSkillProviderRoots(
  distro: string,
  probe: WslEnvironmentProbe = probeWslProviderHomes
): Promise<SkillProviderRootOverrides> {
  try {
    // `$HOME` then each value, all NUL-terminated; any other shape is a broken probe.
    const fields = (await probe(distro))?.split('\0') ?? []
    if (fields.length !== PROVIDER_HOME_ENVS.length + 2) {
      return {}
    }
    const [userHome, ...values] = fields
    const roots: SkillProviderRootOverrides = {}
    PROVIDER_HOME_ENVS.forEach(({ id }, index) => {
      const home = wslProviderHome(values[index], userHome)
      if (home) {
        roots[id] = toWindowsWslPath(`${home}/skills`, distro)
      }
    })
    return roots
  } catch {
    return {}
  }
}
