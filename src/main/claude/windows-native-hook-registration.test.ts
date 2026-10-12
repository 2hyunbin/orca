// Claude alone opts into the native Windows hook (#20913); every other agent keeps its form.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as NativeHookExecutableModule from '../agent-hooks/windows-native-hook-executable'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/userData' } }))

const { bundledHook } = vi.hoisted(() => {
  const bundledHook: { path: string | null } = { path: null }
  return { bundledHook }
})
vi.mock('../agent-hooks/windows-native-hook-executable', async (importOriginal) => ({
  ...(await importOriginal<typeof NativeHookExecutableModule>()),
  resolveBundledWindowsNativeHookExecutable: () => bundledHook.path
}))

import { createManagedCommandMatcher } from '../agent-hooks/installer-utils'
import { ClaudeHookService } from './hook-service'
import {
  CLAUDE_HOOK_SETTINGS,
  getManagedLifecycleHook,
  getWindowsManagedLifecycleHook,
  type ClaudeCompatibleHookSettings
} from './hook-settings'

const CURRENT_CLAUDE = { claudeVersion: '2.1.261 (Claude Code)' }
const SCRIPT_PATH = 'C:\\Users\\alice\\.orca\\agent-hooks\\claude-hook.cmd'
const EXE_PATH = 'C:\\Users\\alice\\.orca\\agent-hooks\\claude-hook.exe'

function withWin32<T>(run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  try {
    return run()
  } finally {
    if (original) {
      Object.defineProperty(process, 'platform', original)
    }
  }
}

describe('getManagedLifecycleHook native executable gate', () => {
  it('registers the installed exe as a bare path for Claude', () => {
    const hook = withWin32(() =>
      getManagedLifecycleHook(SCRIPT_PATH, CLAUDE_HOOK_SETTINGS, EXE_PATH)
    )
    expect(hook).toEqual({
      type: 'command',
      command: 'C:/Users/alice/.orca/agent-hooks/claude-hook.exe',
      timeout: 10
    })
    expect(createManagedCommandMatcher('claude-hook.cmd')(hook.command)).toBe(true)
    expect(createManagedCommandMatcher('codebuddy-hook.cmd')(hook.command)).toBe(false)
  })

  it('keeps every other Claude-compatible agent on its current form', () => {
    const codeBuddyLike: ClaudeCompatibleHookSettings = {
      configDirName: '.codebuddy',
      scriptBaseName: 'codebuddy-hook',
      usesWindowsCompatLauncher: true
    }
    const scriptPath = SCRIPT_PATH.replace('claude-hook', 'codebuddy-hook')
    const hook = withWin32(() =>
      getManagedLifecycleHook(scriptPath, codeBuddyLike, EXE_PATH.replace('claude', 'codebuddy'))
    )
    expect(hook).toEqual(getWindowsManagedLifecycleHook(scriptPath))
  })

  it('falls back to the .cmd form without an installed exe or with a path shells cannot carry', () => {
    for (const exePath of [null, 'C:\\Users\\Bob Smith\\.orca\\agent-hooks\\claude-hook.exe']) {
      const hook = withWin32(() =>
        getManagedLifecycleHook(SCRIPT_PATH, CLAUDE_HOOK_SETTINGS, exePath)
      )
      expect(hook).toEqual(getWindowsManagedLifecycleHook(SCRIPT_PATH))
    }
  })
})

describe.skipIf(process.platform !== 'win32')('ClaudeHookService native hook install', () => {
  let home = ''

  afterEach(() => {
    vi.unstubAllEnvs()
    bundledHook.path = null
    if (home) {
      rmSync(home, { recursive: true, force: true })
      home = ''
    }
  })

  function useTempHome(): { hooksDir: string; settingsPath: string; bundle: string } {
    home = mkdtempSync(join(tmpdir(), 'orca-claude-native-hook-'))
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    const bundle = join(home, 'orca-hook.exe')
    writeFileSync(bundle, 'MZ stand-in for the signed bundle')
    return {
      hooksDir: join(home, '.orca', 'agent-hooks'),
      settingsPath: join(home, '.claude', 'settings.json'),
      bundle
    }
  }

  function managedCommands(settingsPath: string, event: string): string[] {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    return settings.hooks[event]
      .flatMap((definition: { hooks: { command: string }[] }) => definition.hooks)
      .map((hook: { command: string }) => hook.command)
      .filter(createManagedCommandMatcher('claude-hook.cmd'))
  }

  it('copies the bundled exe and registers it, keeping the .cmd pair as the fallback', () => {
    const { hooksDir, settingsPath, bundle } = useTempHome()
    bundledHook.path = bundle

    expect(new ClaudeHookService().install(CURRENT_CLAUDE).state).toBe('installed')
    expect(readFileSync(join(hooksDir, 'claude-hook.exe'), 'utf8')).toBe(
      'MZ stand-in for the signed bundle'
    )
    expect(existsSync(join(hooksDir, 'claude-hook.cmd'))).toBe(true)
    expect(existsSync(join(hooksDir, 'claude-hook-impl.cmd'))).toBe(true)
    expect(managedCommands(settingsPath, 'PreToolUse')).toEqual([
      join(hooksDir, 'claude-hook.exe').replaceAll('\\', '/')
    ])
  })

  it('registers the .cmd hook when no signed exe ships, and status accepts either form', () => {
    const { hooksDir, settingsPath, bundle } = useTempHome()
    const service = new ClaudeHookService()

    expect(service.install(CURRENT_CLAUDE).state).toBe('installed')
    const cmdCommand = join(hooksDir, 'claude-hook.cmd').replaceAll('\\', '/')
    expect(managedCommands(settingsPath, 'Stop')).toEqual([cmdCommand])

    // A later install with the exe sweeps the .cmd entry rather than adding a second hook.
    bundledHook.path = bundle
    expect(service.install(CURRENT_CLAUDE).state).toBe('installed')
    expect(managedCommands(settingsPath, 'Stop')).toEqual([
      join(hooksDir, 'claude-hook.exe').replaceAll('\\', '/')
    ])

    // And back: an install that cannot place the exe returns to the .cmd hook.
    bundledHook.path = join(home, 'missing.exe')
    expect(service.install(CURRENT_CLAUDE).state).toBe('installed')
    expect(managedCommands(settingsPath, 'Stop')).toEqual([cmdCommand])
  })

  it('reports a registered exe that has gone missing as partial', () => {
    const { hooksDir, bundle } = useTempHome()
    bundledHook.path = bundle
    const service = new ClaudeHookService()
    expect(service.install(CURRENT_CLAUDE).state).toBe('installed')

    rmSync(join(hooksDir, 'claude-hook.exe'))
    expect(service.getStatus(CURRENT_CLAUDE).state).toBe('partial')
  })

  it('refreshes a surviving exe to this build, and never creates one', async () => {
    const { hooksDir, bundle } = useTempHome()
    const service = new ClaudeHookService()
    bundledHook.path = bundle
    await service.refreshManagedScripts()
    expect(existsSync(join(hooksDir, 'claude-hook.exe'))).toBe(false)

    expect(service.install(CURRENT_CLAUDE).state).toBe('installed')
    writeFileSync(bundle, 'MZ next build')
    await service.refreshManagedScripts()
    expect(readFileSync(join(hooksDir, 'claude-hook.exe'), 'utf8')).toBe('MZ next build')
  })
})
