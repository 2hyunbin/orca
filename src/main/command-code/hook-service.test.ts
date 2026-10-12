import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AddressInfo } from 'node:net'

const { homedirMock } = vi.hoisted(() => ({
  homedirMock: vi.fn<() => string>()
}))

vi.mock('os', async () => {
  const actual = (await vi.importActual('os')) as Record<string, unknown>
  return {
    ...actual,
    homedir: homedirMock
  }
})

import { CommandCodeHookService } from './hook-service'
import { WINDOWS_CMD_SAFE_PATH, wrapWindowsHookCommand } from '../agent-hooks/installer-utils'

const WINDOWS_POWERSHELL_LAUNCHER =
  /^[A-Za-z]:\/[^"]*\/System32\/WindowsPowerShell\/v1\.0\/powershell\.exe -NoProfile -EncodedCommand \S+$/

describe('CommandCodeHookService', () => {
  let homeDir: string

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'orca-command-code-home-'))
    homedirMock.mockReturnValue(homeDir)
  })

  afterEach(() => {
    vi.clearAllMocks()
    rmSync(homeDir, { recursive: true, force: true })
  })

  it('installs the managed command for Command Code status events', () => {
    const status = new CommandCodeHookService().install()

    expect(status.state).toBe('installed')
    expect(status.managedHooksPresent).toBe(true)

    const config = JSON.parse(
      readFileSync(join(homeDir, '.commandcode', 'settings.json'), 'utf8')
    ) as {
      hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>
    }
    expect(Object.keys(config.hooks).sort()).toEqual(['PostToolUse', 'PreToolUse', 'Stop'].sort())
    expect(config.hooks.PreToolUse[0].matcher).toBe('.*')
    expect(config.hooks.PostToolUse[0].matcher).toBe('.*')
    expect(config.hooks.Stop[0].matcher).toBeUndefined()
    expect(config.hooks.PreToolUse[0].hooks[0].command).toMatch(/command-code-hook/)
    if (process.platform !== 'win32') {
      expect(config.hooks.PreToolUse[0].hooks[0].command).toContain(join(homeDir, '.orca'))
    }
    if (process.platform !== 'win32') {
      expect(config.hooks.PreToolUse[0].hooks[0].command).toMatch(/^if \[ -f /)
    }
  })

  // Why: Command Code already runs hooks through cmd.exe; an encoded PowerShell in between cost ~0.6s per event.
  it.skipIf(process.platform !== 'win32')(
    'registers the managed .cmd path directly on a cmd-safe profile',
    () => {
      const scriptPath = join(homeDir, '.orca', 'agent-hooks', 'command-code-hook.cmd')
      expect(WINDOWS_CMD_SAFE_PATH.test(scriptPath), 'test home must be cmd-safe').toBe(true)
      expect(new CommandCodeHookService().install().state).toBe('installed')

      const config = JSON.parse(
        readFileSync(join(homeDir, '.commandcode', 'settings.json'), 'utf8')
      )
      for (const eventName of ['PreToolUse', 'PostToolUse', 'Stop']) {
        expect(config.hooks[eventName][0].hooks[0].command).toBe(scriptPath.replaceAll('\\', '/'))
      }
    }
  )

  it.skipIf(process.platform !== 'win32')(
    'rewrites a stale encoded launcher registration to the direct form',
    () => {
      const scriptPath = join(homeDir, '.orca', 'agent-hooks', 'command-code-hook.cmd')
      const configPath = join(homeDir, '.commandcode', 'settings.json')
      mkdirSync(join(homeDir, '.commandcode'), { recursive: true })
      const stale = { type: 'command', command: wrapWindowsHookCommand(scriptPath) }
      writeFileSync(configPath, JSON.stringify({ hooks: { Stop: [{ hooks: [stale] }] } }))

      expect(new CommandCodeHookService().install().state).toBe('installed')

      const config = JSON.parse(readFileSync(configPath, 'utf8'))
      expect(config.hooks.Stop).toHaveLength(1)
      expect(config.hooks.Stop[0].hooks).toEqual([
        expect.objectContaining({ command: scriptPath.replaceAll('\\', '/') })
      ])
    }
  )

  // Why: #6078 — a Windows user profile path with a space used to be written
  // verbatim as the hook command, so the agent split it at the space. A profile
  // the bare path cannot carry keeps the encoded launcher.
  it
    .skipIf(process.platform !== 'win32')
    .each(['orca command-code home with spaces', 'orca-command-code-hömé'])(
    'keeps the encoded launcher for a profile the bare path cannot carry (%s)',
    (homeName) => {
      const spaceHome = join(tmpdir(), homeName)
      mkdirSync(spaceHome, { recursive: true })
      homedirMock.mockReturnValue(spaceHome)
      try {
        expect(new CommandCodeHookService().install().state).toBe('installed')

        const config = JSON.parse(
          readFileSync(join(spaceHome, '.commandcode', 'settings.json'), 'utf8')
        ) as { hooks: Record<string, { hooks: { command: string }[] }[]> }

        const command = config.hooks.PreToolUse[0].hooks[0].command
        expect(command).toMatch(WINDOWS_POWERSHELL_LAUNCHER)
      } finally {
        rmSync(spaceHome, { recursive: true, force: true })
      }
    }
  )

  it('installs a hook script that can recover the endpoint when Command Code strips token env', () => {
    new CommandCodeHookService().install()

    const scriptFileName =
      process.platform === 'win32' ? 'command-code-hook.cmd' : 'command-code-hook.sh'
    const script = readFileSync(join(homeDir, '.orca', 'agent-hooks', scriptFileName), 'utf8')

    if (process.platform === 'win32') {
      expect(script).toContain('sourceEndpointByPort')
      expect(script).toContain('orca-dev\\agent-hooks')
      expect(script).toContain('set ORCA_AGENT_HOOK_PORT=')
    } else {
      expect(script).toContain('Command Code strips TOKEN-like env vars')
      expect(script).toContain('Command Code sanitizes hook subprocess env')
      expect(script).toContain('__orca_read_ancestor_var')
      expect(script).toContain('__orca_fill_from_endpoint_file')
      expect(script).toContain('[ "$__orca_endpoint_port" != "$ORCA_AGENT_HOOK_PORT" ]')
      expect(script).toContain('ORCA_PANE_KEY')
      expect(script).toContain('ORCA_AGENT_LAUNCH_TOKEN')
      expect(script).toContain('orca-dev/agent-hooks')
      expect(script).toContain('endpoint_port=')
    }
  })

  const itPosix = process.platform === 'win32' ? it.skip : it

  itPosix('does not let stale endpoint files clobber recovered connection fields', async () => {
    new CommandCodeHookService().install()

    const staleEndpointPath = join(homeDir, 'stale-endpoint.env')
    writeFileSync(
      staleEndpointPath,
      [
        'ORCA_AGENT_HOOK_PORT=9',
        'ORCA_AGENT_HOOK_TOKEN=stale-token',
        'ORCA_AGENT_HOOK_ENV=development',
        'ORCA_AGENT_HOOK_VERSION=1',
        ''
      ].join('\n')
    )

    const requests: { body: string; token: string | string[] | undefined }[] = []
    const server = createServer((req, res) => {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        requests.push({
          body,
          token: req.headers['x-orca-agent-hook-token']
        })
        res.statusCode = 204
        res.end()
      })
    })

    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address() as AddressInfo
      const scriptPath = join(homeDir, '.orca', 'agent-hooks', 'command-code-hook.sh')
      const child = spawn('/bin/sh', [scriptPath], {
        env: {
          ...process.env,
          HOME: homeDir,
          ORCA_AGENT_HOOK_ENDPOINT: staleEndpointPath,
          ORCA_AGENT_HOOK_PORT: String(address.port),
          ORCA_AGENT_HOOK_TOKEN: 'current-token',
          ORCA_PANE_KEY: 'tab:leaf',
          ORCA_TAB_ID: 'tab',
          ORCA_WORKTREE_ID: 'worktree',
          ORCA_AGENT_HOOK_ENV: 'development',
          ORCA_AGENT_HOOK_VERSION: '1'
        },
        stdio: ['pipe', 'ignore', 'pipe']
      })
      child.stdin.end(JSON.stringify({ hook_event_name: 'Stop' }))

      const exitCode = await new Promise<number | null>((resolve, reject) => {
        let stderr = ''
        child.stderr.setEncoding('utf8')
        child.stderr.on('data', (chunk) => {
          stderr += chunk
        })
        child.on('error', reject)
        child.on('exit', (code) => {
          if (stderr.trim()) {
            reject(new Error(stderr))
          } else {
            resolve(code)
          }
        })
      })

      expect(exitCode).toBe(0)
      expect(requests).toHaveLength(1)
      expect(requests[0].token).toBe('current-token')
      expect(new URLSearchParams(requests[0].body).get('paneKey')).toBe('tab:leaf')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('reports partial when one managed event is missing', () => {
    const service = new CommandCodeHookService()
    service.install()

    const configPath = join(homeDir, '.commandcode', 'settings.json')
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      hooks: Record<string, unknown>
    }
    delete config.hooks.Stop
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)

    const status = service.getStatus()

    expect(status.state).toBe('partial')
    expect(status.managedHooksPresent).toBe(true)
    expect(status.detail).toBe('Managed hook missing for events: Stop')
  })
})
