import { readdir, readFile, stat } from 'node:fs/promises'
import { userInfo } from 'node:os'
import path from 'node:path'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import type { ClaudeProfileRead } from '../claude-accounts/claude-profile-paths'

type JsonObjectRead = ClaudeProfileRead<Record<string, unknown>>

/** Where Claude Code reads admin-deployed settings on one OS. */
export type ClaudeManagedSettingsLocations = {
  files: string[]
  dropInDirs: string[]
  /** Policy files Orca cannot parse without a subprocess: their presence alone makes the answer unknown. */
  opaqueFiles: string[]
  /** A policy store Orca does not read here (the Windows registry), so absence is never proven. */
  hasUncheckedStore: boolean
}

export function claudeManagedSettingsLocations(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env
): ClaudeManagedSettingsLocations {
  if (platform === 'win32') {
    // Why both: Claude Code moved it from ProgramData to Program Files.
    const dirs = [
      path.win32.join(env.ProgramFiles ?? 'C:\\Program Files', 'ClaudeCode'),
      path.win32.join(env.ProgramData ?? 'C:\\ProgramData', 'ClaudeCode')
    ]
    return { ...managedFilesIn(dirs, path.win32), opaqueFiles: [], hasUncheckedStore: true }
  }
  if (platform === 'darwin') {
    const plist = 'com.anthropic.claudecode.plist'
    return {
      ...managedFilesIn(['/Library/Application Support/ClaudeCode'], path.posix),
      opaqueFiles: [
        path.posix.join('/Library/Managed Preferences', plist),
        ...userManagedPreferences(plist)
      ],
      hasUncheckedStore: false
    }
  }
  return {
    ...managedFilesIn(['/etc/claude-code'], path.posix),
    opaqueFiles: [],
    hasUncheckedStore: false
  }
}

/** Every settings file Claude merges outside a project: the user's, then managed ones. */
export async function readClaudeSettingsSources(
  userConfigDir: string,
  managed: ClaudeManagedSettingsLocations
): Promise<JsonObjectRead[]> {
  const files = [
    path.join(userConfigDir, 'settings.json'),
    path.join(userConfigDir, 'settings.local.json'),
    ...managed.files
  ]
  const reads = await Promise.all(files.map(readJsonObject))
  for (const dir of managed.dropInDirs) {
    reads.push(...(await readDropIns(dir)))
  }
  for (const file of managed.opaqueFiles) {
    reads.push(await probeOpaque(file))
  }
  return reads
}

export async function readJsonObject(file: string): Promise<JsonObjectRead> {
  try {
    const value: unknown = JSON.parse(await readFile(file, 'utf8'))
    return isRecord(value) ? { kind: 'present', value } : { kind: 'unavailable', error: null }
  } catch (error) {
    return isDefinitiveAbsence(error) ? { kind: 'absent' } : { kind: 'unavailable', error }
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function managedFilesIn(
  dirs: string[],
  paths: typeof path.posix
): Pick<ClaudeManagedSettingsLocations, 'files' | 'dropInDirs'> {
  return {
    files: dirs.map((dir) => paths.join(dir, 'managed-settings.json')),
    dropInDirs: dirs.map((dir) => paths.join(dir, 'managed-settings.d'))
  }
}

function userManagedPreferences(plist: string): string[] {
  try {
    return [path.posix.join('/Library/Managed Preferences', userInfo().username, plist)]
  } catch {
    // Why: an unknown user leaves that policy unchecked, so it must read as unknown.
    return ['']
  }
}

async function readDropIns(dir: string): Promise<JsonObjectRead[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (error) {
    return isDefinitiveAbsence(error) ? [] : [{ kind: 'unavailable', error }]
  }
  const jsonNames = names.filter((name) => name.endsWith('.json') && !name.startsWith('.'))
  return Promise.all(jsonNames.map((name) => readJsonObject(path.join(dir, name))))
}

async function probeOpaque(file: string): Promise<JsonObjectRead> {
  if (!file) {
    return { kind: 'unavailable', error: null }
  }
  try {
    await stat(file)
    return { kind: 'unavailable', error: null }
  } catch (error) {
    return isDefinitiveAbsence(error) ? { kind: 'absent' } : { kind: 'unavailable', error }
  }
}
