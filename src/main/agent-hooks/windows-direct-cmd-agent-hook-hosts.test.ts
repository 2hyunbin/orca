// Why: Grok, Devin, ZCode and Antigravity may run hook commands through Git Bash, which strips the
// backslashes out of a bare `C:\...\x.cmd`. Run each registered command through every host.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as osModule from 'node:os'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'
import { WINDOWS_CMD_SAFE_PATH } from './installer-utils'
import { getWindowsPowerShellExecutablePath } from './windows-powershell-hook-launcher'
import { findGitBash } from './windows-git-bash-path.test-fixture'

const { homedirMock } = vi.hoisted(() => ({ homedirMock: vi.fn<() => string>() }))

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof osModule>()
  return { ...actual, homedir: homedirMock.mockImplementation(actual.homedir) }
})
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

import { AntigravityHookService } from '../antigravity/hook-service'
import { DevinHookService } from '../devin/hook-service'
import { getDevinConfigPath } from '../devin/hook-settings'
import { GrokHookService } from '../grok/hook-service'
import { zcodeHookService } from '../zcode/hook-service'
import { getZCodeConfigPath } from '../zcode/hook-settings'

type StopEntry = { command?: string; hooks?: { command?: string }[] }

function stopCommand(entries: StopEntry[] | undefined): string {
  const command = entries?.at(-1)?.hooks?.[0]?.command ?? entries?.at(-1)?.command
  expect(command, 'registered Stop command').toBeDefined()
  return command!
}

type RegisteredConfig = {
  hooks?: { Stop?: StopEntry[]; events?: { Stop?: StopEntry[] } }
  'orca-status'?: { Stop?: StopEntry[] }
}

// Why no assertion: `JSON.parse` is already `any`, so the annotation narrows without a cast.
function readJson(path: string): RegisteredConfig {
  return JSON.parse(readFileSync(path, 'utf8'))
}

const AGENTS: [string, (home: string) => string][] = [
  [
    'grok',
    (home) => {
      expect(new GrokHookService().install().state).toBe('installed')
      const config = readJson(join(home, '.grok', 'hooks', 'orca-status.json'))
      return stopCommand(config.hooks?.Stop)
    }
  ],
  [
    'devin',
    () => {
      expect(new DevinHookService().install().state).toBe('installed')
      const config = readJson(getDevinConfigPath())
      return stopCommand(config.hooks?.Stop)
    }
  ],
  [
    'zcode',
    () => {
      expect(zcodeHookService.install().state).toBe('installed')
      const config = readJson(getZCodeConfigPath())
      return stopCommand(config.hooks?.events?.Stop)
    }
  ],
  [
    'antigravity',
    (home) => {
      const service = new AntigravityHookService()
      service.setWindowsRuntimePathProvider(() => process.execPath)
      expect(service.install().state).toBe('installed')
      const config = readJson(join(home, '.gemini', 'config', 'hooks.json'))
      return stopCommand(config['orca-status']?.Stop)
    }
  ]
]

async function startListener(): Promise<{ server: Server; port: number; paths: string[] }> {
  const paths: string[] = []
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      paths.push(req.url ?? '')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
  })
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address ? address.port : 0)
    })
  })
  return { server, port, paths }
}

// Why: a runner whose TEMP is not cmd-safe registers the encoded launcher, not this shape.
const tempIsCmdSafe = WINDOWS_CMD_SAFE_PATH.test(join(tmpdir(), 'orca-direct-agent-hook-x'))

describe.skipIf(process.platform !== 'win32')('direct agent hook commands in Windows hosts', () => {
  let home = ''
  let listener: Awaited<ReturnType<typeof startListener>> | null = null

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'orca-direct-agent-hook-'))
    homedirMock.mockReturnValue(home)
    vi.stubEnv('APPDATA', join(home, 'AppData', 'Roaming'))
    vi.stubEnv('GROK_HOME', '')
    listener = await startListener()
  })

  afterEach(() => {
    listener?.server.close()
    listener = null
    vi.unstubAllEnvs()
    removeTreeSync(home)
  })

  async function run(file: string, args: string[]) {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('ORCA_'))
    )
    const result = await runProcess({
      program: file,
      args,
      cwd: home,
      env: {
        ...env,
        ORCA_BACKGROUND_LAUNCH: '1',
        ORCA_AGENT_HOOK_PORT: String(listener!.port),
        ORCA_AGENT_HOOK_TOKEN: 'direct-agent-hook-token',
        ORCA_PANE_KEY: 'tab-1:leaf-1'
      },
      input: '{"hook_event_name":"Stop"}',
      timeoutMs: 15_000
    })
    expect(result.timedOut, result.stderr).toBe(false)
    // Why: curl returns once the POST is written; let the listener finish reading it.
    await new Promise((resolve) => setTimeout(resolve, 250))
    return result
  }

  it.skipIf(!tempIsCmdSafe).each(AGENTS)(
    '%s posts from cmd, PowerShell and Git Bash',
    async (agent, install) => {
      const command = install(home)
      expect(command).toMatch(/^[A-Za-z]:\/[^\\\s]+\.cmd$/)
      // Proves the `os` mock reached the agents' `node:os` imports (Vitest normalizes builtins).
      expect(command.startsWith(`${home.replaceAll('\\', '/')}/.orca/agent-hooks/`)).toBe(true)

      const hosts: [string, string[]][] = [
        ['cmd.exe', ['/d', '/c', command]],
        [getWindowsPowerShellExecutablePath(), ['-NoProfile', '-Command', command]],
        [findGitBash(), ['-c', command]]
      ]
      for (const [file, args] of hosts) {
        const before = listener!.paths.length
        const result = await run(file, args)
        expect(result.code, `${file}: ${result.stderr}`).toBe(0)
        expect(listener!.paths.slice(before), file).toEqual([`/hook/${agent}`])
      }

      // The legacy backslash entry is what Git Bash could not start.
      const legacy = await run(findGitBash(), ['-c', command.replaceAll('/', '\\')])
      expect(legacy.code).toBe(127)
    }
  )
})
