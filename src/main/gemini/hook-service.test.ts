import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as osModule from 'node:os'

const { getPathMock, homedirMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>(),
  homedirMock: vi.fn<() => string>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  }
}))

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof osModule>()
  return {
    ...actual,
    homedir: homedirMock
  }
})

import { GeminiHookService } from './hook-service'
import { WINDOWS_CMD_SAFE_PATH, wrapWindowsHookCommand } from '../agent-hooks/installer-utils'

const WINDOWS_POWERSHELL_LAUNCHER =
  /^[A-Za-z]:\/[^"]*\/System32\/WindowsPowerShell\/v1\.0\/powershell\.exe -NoProfile -EncodedCommand \S+$/

describe('GeminiHookService', () => {
  let homeDir: string
  let userDataDir: string

  beforeAll(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'orca-gemini-home-'))
    userDataDir = mkdtempSync(join(tmpdir(), 'orca-gemini-userdata-'))
    homedirMock.mockReturnValue(homeDir)
    getPathMock.mockImplementation((name: string) => {
      if (name === 'userData') {
        return userDataDir
      }
      throw new Error(`unexpected getPath(${name})`)
    })
  })

  afterAll(() => {
    rmSync(homeDir, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  })

  it('removes stale PreToolUse hooks when reinstalling managed Gemini hooks', () => {
    const managedHookFileName = process.platform === 'win32' ? 'gemini-hook.cmd' : 'gemini-hook.sh'
    const staleManagedHookPath =
      process.platform === 'win32'
        ? `C:\\Users\\ramzi\\.orca\\agent-hooks\\${managedHookFileName}`
        : `/Users/ramzi/.orca/agent-hooks/${managedHookFileName}`
    const staleManagedCommand =
      process.platform === 'win32'
        ? staleManagedHookPath
        : `if [ -x '${staleManagedHookPath}' ]; then /bin/sh '${staleManagedHookPath}'; fi`
    const managedHookPath = join(homeDir, '.orca', 'agent-hooks', managedHookFileName)
    const configDir = join(homeDir, '.gemini')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify(
        {
          hooks: {
            BeforeAgent: [
              {
                hooks: [{ type: 'command', command: 'echo user-before-agent' }]
              }
            ],
            PreToolUse: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: staleManagedCommand
                  }
                ]
              }
            ]
          }
        },
        null,
        2
      )
    )

    const service = new GeminiHookService()
    const status = service.install()
    const config = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'))

    expect(status.state).toBe('installed')
    expect(Object.keys(config.hooks).sort()).toEqual([
      'AfterAgent',
      'AfterTool',
      'BeforeAgent',
      'BeforeTool'
    ])
    expect(config.hooks.PreToolUse).toBeUndefined()
    expect(config.hooks.BeforeAgent).toHaveLength(2)
    expect(config.hooks.BeforeAgent[0].hooks[0].command).toBe('echo user-before-agent')
    const managedCommandPattern =
      process.platform === 'win32'
        ? managedHookPath.replaceAll('\\', '/')
        : new RegExp(managedHookPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    expect(config.hooks.BeforeAgent[1].hooks[0].command).toMatch(managedCommandPattern)
    expect(config.hooks.AfterAgent[0].hooks[0].command).toMatch(managedCommandPattern)
    expect(config.hooks.AfterTool[0].hooks[0].command).toMatch(managedCommandPattern)
    expect(config.hooks.BeforeTool[0].hooks[0].command).toMatch(managedCommandPattern)
  })

  // Why: Gemini already runs hooks in PowerShell; a second, encoded PowerShell cost ~0.7s per event.
  it.skipIf(process.platform !== 'win32')(
    'registers the managed .cmd path directly on a cmd-safe profile',
    () => {
      const scriptPath = join(homeDir, '.orca', 'agent-hooks', 'gemini-hook.cmd')
      expect(WINDOWS_CMD_SAFE_PATH.test(scriptPath), 'test home must be cmd-safe').toBe(true)
      expect(new GeminiHookService().install().state).toBe('installed')

      const config = JSON.parse(readFileSync(join(homeDir, '.gemini', 'settings.json'), 'utf8'))
      for (const eventName of ['BeforeAgent', 'AfterAgent', 'AfterTool', 'BeforeTool']) {
        expect(config.hooks[eventName].at(-1).hooks[0].command).toBe(
          scriptPath.replaceAll('\\', '/')
        )
      }
    }
  )

  it.skipIf(process.platform !== 'win32')(
    'rewrites a stale encoded launcher registration to the direct form',
    () => {
      const scriptPath = join(homeDir, '.orca', 'agent-hooks', 'gemini-hook.cmd')
      const configDir = join(homeDir, '.gemini')
      mkdirSync(configDir, { recursive: true })
      const stale = { type: 'command', command: wrapWindowsHookCommand(scriptPath) }
      writeFileSync(
        join(configDir, 'settings.json'),
        JSON.stringify({ hooks: { BeforeAgent: [{ hooks: [stale] }] } })
      )

      expect(new GeminiHookService().install().state).toBe('installed')

      const config = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'))
      expect(config.hooks.BeforeAgent).toHaveLength(1)
      expect(config.hooks.BeforeAgent[0].hooks).toEqual([
        expect.objectContaining({ command: scriptPath.replaceAll('\\', '/') })
      ])
    }
  )

  // Why: #6078 — a Windows user profile path with a space used to be written
  // verbatim as the hook command, so the agent split it at the space. A profile
  // the bare path cannot carry keeps the encoded launcher.
  it
    .skipIf(process.platform !== 'win32')
    .each(['orca gemini home with spaces', 'orca-gemini-hömé'])(
    'keeps the encoded launcher for a profile the bare path cannot carry (%s)',
    (homeName) => {
      const spaceHome = join(tmpdir(), homeName)
      mkdirSync(spaceHome, { recursive: true })
      homedirMock.mockReturnValue(spaceHome)
      try {
        expect(new GeminiHookService().install().state).toBe('installed')

        const config = JSON.parse(
          readFileSync(join(spaceHome, '.gemini', 'settings.json'), 'utf8')
        ) as { hooks: Record<string, { hooks: { command: string }[] }[]> }

        for (const eventName of ['BeforeAgent', 'AfterAgent', 'AfterTool']) {
          const command = config.hooks[eventName]?.[0]?.hooks?.[0]?.command
          expect(command).toMatch(WINDOWS_POWERSHELL_LAUNCHER)
        }
      } finally {
        rmSync(spaceHome, { recursive: true, force: true })
        homedirMock.mockReturnValue(homeDir)
      }
    }
  )

  it('preserves user-authored PreToolUse hooks while sweeping stale managed Gemini hooks', () => {
    const managedHookFileName = process.platform === 'win32' ? 'gemini-hook.cmd' : 'gemini-hook.sh'
    const staleManagedHookPath =
      process.platform === 'win32'
        ? `C:\\Users\\ramzi\\.orca\\agent-hooks\\${managedHookFileName}`
        : `/Users/ramzi/.orca/agent-hooks/${managedHookFileName}`
    const staleManagedCommand =
      process.platform === 'win32'
        ? staleManagedHookPath
        : `if [ -x '${staleManagedHookPath}' ]; then /bin/sh '${staleManagedHookPath}'; fi`
    const configDir = join(homeDir, '.gemini')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              {
                hooks: [{ type: 'command', command: staleManagedCommand }]
              },
              {
                hooks: [{ type: 'command', command: 'echo user-authored' }]
              }
            ]
          }
        },
        null,
        2
      )
    )

    const status = new GeminiHookService().install()
    const config = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'))
    const preToolCommands = config.hooks.PreToolUse.flatMap(
      (definition: { hooks?: { command: string }[] }) =>
        (definition.hooks ?? []).map((hook) => hook.command)
    )

    expect(status.state).toBe('installed')
    expect(preToolCommands).toEqual(['echo user-authored'])
    expect(config.hooks.BeforeTool[0].hooks[0].command).toMatch(
      process.platform === 'win32'
        ? join(homeDir, '.orca', 'agent-hooks', managedHookFileName).replaceAll('\\', '/')
        : new RegExp(managedHookFileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    )
  })
})
