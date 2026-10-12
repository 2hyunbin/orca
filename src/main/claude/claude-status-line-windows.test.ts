// Why: Claude runs the statusLine under Git Bash when present, else PowerShell. The POSIX
// runtime-home form Orca used to register is a PowerShell parse error, so a Windows box
// without Git Bash never posted rate_limits and the live usage feed went dark.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as osModule from 'node:os'
import { runProcess } from '@orca/process-host'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'
import { parseClaudeStatusLineBody } from '../../shared/claude-statusline-rate-limits'

const { homedirMock } = vi.hoisted(() => ({
  homedirMock: vi.fn<() => string>()
}))

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/orca-user-data' } }))

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof osModule>()
  return { ...actual, homedir: homedirMock.mockImplementation(actual.homedir) }
})

import { findGitBash } from '../agent-hooks/windows-git-bash-path.test-fixture'
import { ClaudeHookService } from './hook-service'
import { getManagedCommand, getWindowsManagedLifecycleHook } from './hook-settings'

const CURRENT_CLAUDE = { claudeVersion: '2.1.261 (Claude Code)' }
const USER_STATUS_LINES = [
  { type: 'command', command: 'C:/tools/my-statusline.cmd' },
  {
    type: 'command',
    command: 'powershell -NoProfile -File C:\\tools\\statusline.ps1'
  }
]

type StatusLineSettings = { statusLine?: { type: string; command: string } }

function statusLineScriptPath(home: string): string {
  return join(home, '.orca', 'agent-hooks', 'claude-statusline.cmd')
}

function readSettings(home: string): StatusLineSettings {
  return JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8'))
}

function seedSettings(home: string, settings: StatusLineSettings): void {
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(settings))
}

describe('Claude statusLine registration on Windows', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  let home = ''

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'orca-claude-statusline-win-'))
    homedirMock.mockReturnValue(home)
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true
    })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', platform)
    homedirMock.mockReset()
    removeTreeSync(home)
  })

  it('registers the shell-neutral .cmd invocation, not the POSIX runtime-home form', () => {
    new ClaudeHookService().install(CURRENT_CLAUDE)

    const command = readSettings(home).statusLine?.command
    expect(command).toBe(getWindowsManagedLifecycleHook(statusLineScriptPath(home)).command)
    expect(command).not.toContain('${HOME-}')
  })

  it('replaces the POSIX runtime-home statusLine an older Orca registered', () => {
    seedSettings(home, {
      statusLine: {
        type: 'command',
        command: getManagedCommand(statusLineScriptPath(home))
      }
    })
    // Why: the marker from that older install must not read as the user's opt-out.
    mkdirSync(join(home, '.orca', 'agent-hooks'), { recursive: true })
    writeFileSync(join(home, '.orca', 'agent-hooks', 'claude-statusline.installed'), '')

    new ClaudeHookService().install(CURRENT_CLAUDE)

    expect(readSettings(home).statusLine).toEqual({
      type: 'command',
      command: getWindowsManagedLifecycleHook(statusLineScriptPath(home)).command
    })
  })

  it.each(USER_STATUS_LINES)('never overwrites or removes a user statusLine: $command', (user) => {
    seedSettings(home, { statusLine: user })

    new ClaudeHookService().install(CURRENT_CLAUDE)
    expect(readSettings(home).statusLine).toEqual(user)

    new ClaudeHookService().remove()
    expect(readSettings(home).statusLine).toEqual(user)
  })
})

const PAYLOAD = JSON.stringify({
  session_id: 'statusline-delivery',
  model: { id: 'claude-opus-5-5', display_name: 'Opus' },
  rate_limits: {
    five_hour: { used_percentage: 42, resets_at: 1790000000 },
    seven_day: { used_percentage: 7, resets_at: 1790500000 }
  }
})
const HOOK_TOKEN = 'statusline-delivery-token'

async function startStatusLineListener(): Promise<{
  server: Server
  port: number
  posts: Record<string, string>[]
}> {
  const posts: Record<string, string>[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      posts.push({
        ...Object.fromEntries(new URLSearchParams(body)),
        path: req.url ?? ''
      })
      res.writeHead(200)
      res.end()
    })
  })
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address ? address.port : 0)
    })
  })
  return { server, port, posts }
}

describe.skipIf(process.platform !== 'win32')('Claude statusLine delivery on Windows', () => {
  let home = ''
  let server: Server | null = null

  afterEach(() => {
    server?.close()
    server = null
    homedirMock.mockReset()
    if (home) {
      removeTreeSync(home)
      home = ''
    }
  })

  it('posts rate_limits and prints nothing under Windows PowerShell 5.1 and Git Bash', async () => {
    home = mkdtempSync(join(tmpdir(), 'orca-claude-statusline-run-'))
    homedirMock.mockReturnValue(home)
    // Why: a developer's cmd AutoRun commonly targets %USERPROFILE%\.cmd_aliases.cmd.
    writeFileSync(join(home, '.cmd_aliases.cmd'), '@rem\r\n', 'utf8')
    new ClaudeHookService().install(CURRENT_CLAUDE)
    const command = readSettings(home).statusLine?.command
    if (!command) {
      throw new Error('Missing managed statusLine command')
    }

    const listener = await startStatusLineListener()
    server = listener.server
    const baseEnv = Object.fromEntries(
      // Why: a CLAUDE_JOB_DIR inherited from a hosting Claude session would gate the script off.
      Object.entries(process.env).filter(([key]) => !/^(ORCA|CLAUDE)_/.test(key))
    )
    // Why: claude.exe's own PowerShell argv (-ExecutionPolicy Bypass unless told to respect it).
    const powershell = join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    )
    const powershellArgs = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command'
    ]
    const run = (program: string, args: string[], paneId: string) =>
      runProcess({
        program,
        args,
        input: PAYLOAD,
        timeoutMs: 15_000,
        env: {
          ...baseEnv,
          USERPROFILE: home,
          HOME: home,
          // Why: keeps the per-pane throttle stamp out of the real %TEMP%.
          TEMP: home,
          TMP: home,
          ORCA_BACKGROUND_LAUNCH: '1',
          ORCA_AGENT_HOOK_PORT: String(listener.port),
          ORCA_AGENT_HOOK_TOKEN: HOOK_TOKEN,
          ORCA_PANE_KEY: `tab-1:00000000-0000-4000-8000-00000000000${paneId}`
        }
      })

    // The pre-fix registration, pinned so this suite proves the regression it guards.
    const legacy = await run(
      powershell,
      [...powershellArgs, getManagedCommand(statusLineScriptPath(home))],
      '0'
    )
    expect(legacy.code).not.toBe(0)
    expect(listener.posts).toHaveLength(0)

    const shells = [
      {
        name: 'Windows PowerShell',
        program: powershell,
        args: [...powershellArgs, command]
      },
      { name: 'Git Bash', program: findGitBash(), args: ['-c', command] }
    ]
    for (const [index, shell] of shells.entries()) {
      const result = await run(shell.program, shell.args, String(index + 1))
      expect(result.timedOut, `${shell.name} timed out`).toBe(false)
      expect(result.code, `${shell.name} exit code`).toBe(0)
      // Why: parity with the POSIX script — the usage feed must not change what Claude displays.
      expect(result.stdout, `${shell.name} stdout`).toBe('')
      expect(result.stderr, `${shell.name} stderr`).toBe('')

      const post = listener.posts[index]
      expect(post?.path, `${shell.name} posted`).toBe('/statusline/claude')
      expect(parseClaudeStatusLineBody(post)).toEqual({
        configDir: null,
        fiveHour: { used_percentage: 42, resets_at: 1790000000 },
        sevenDay: { used_percentage: 7, resets_at: 1790500000 }
      })
    }
    expect(listener.posts).toHaveLength(shells.length)
  }, 60_000)
})
