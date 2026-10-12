// Why: Gemini, DSH, Kiro, Droid and Command Code register the managed `.cmd` path directly on a
// cmd-safe profile. Each vendor starts that string through its own shell, so this suite installs
// into a temp profile and runs the registered command the way each runner does, following a
// non-ASCII payload to a mock listener byte-for-byte.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as osModule from 'node:os'

const { homedirMock } = vi.hoisted(() => ({
  homedirMock: vi.fn<() => string>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => join(tmpdir(), 'orca-direct-cmd-runner-user-data')
  }
}))

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof osModule>()
  return {
    ...actual,
    homedir: homedirMock.mockImplementation(actual.homedir)
  }
})

import { CommandCodeHookService } from '../command-code/hook-service'
import { DroidHookService } from '../droid/hook-service'
import { DshHookService } from '../dsh/hook-service'
import { GeminiHookService } from '../gemini/hook-service'
import { KiroHookService } from '../kiro/hook-service'
import { WINDOWS_CMD_SAFE_PATH } from './installer-utils'

const PANE_KEY = 'tab-1:leaf-1'
const HOOK_TOKEN = 'direct-cmd-runner-token'
const PAYLOAD = JSON.stringify({
  session_id: 'direct-cmd-runner',
  hook_event_name: 'UserPromptSubmit',
  prompt: 'café 日本語 😀 & echo %PATH% | more',
  transcript: 'y'.repeat(4096)
})

type Runner = {
  name: string
  program: string
  args: (command: string) => string[]
  verbatim?: boolean
}

const SYSTEM_ROOT = process.env.SystemRoot ?? 'C:\\Windows'
const CMD = join(SYSTEM_ROOT, 'System32', 'cmd.exe')
const POWERSHELL = join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

// Each argv is the vendor's own spawn (pwsh-first runners fall back to Windows PowerShell 5.1).
const CMD_NODE_SHELL: Runner = {
  name: 'cmd.exe (Node shell:true)',
  program: CMD,
  args: (command) => ['/d', '/s', '/c', `"${command}"`],
  verbatim: true
}
const CMD_FACTORY: Runner = {
  name: 'cmd.exe (Factory)',
  program: CMD,
  args: (command) => ['/d', '/s', '/c', command],
  verbatim: true
}
const POWERSHELL_GEMINI: Runner = {
  name: 'Windows PowerShell (Gemini)',
  program: POWERSHELL,
  args: (command) => [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `${command}; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`
  ]
}
const POWERSHELL_DSH: Runner = {
  name: 'Windows PowerShell (DSH)',
  program: POWERSHELL,
  args: (command) => [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;$OutputEncoding=[System.Text.Encoding]::UTF8;${command}`
  ]
}
const POWERSHELL_PLAIN: Runner = {
  name: 'Windows PowerShell',
  program: POWERSHELL,
  args: (command) => ['-NoProfile', '-Command', command]
}

type JsonHooks = { hooks: Record<string, { hooks?: { command: string }[]; command?: string }[]> }

function readJson(path: string): JsonHooks {
  return JSON.parse(readFileSync(path, 'utf8'))
}

const PROVIDERS = [
  {
    name: 'Droid',
    script: 'droid-hook.cmd',
    runners: [CMD_FACTORY],
    stdout: '',
    install: () => new DroidHookService().install(),
    command: (home: string) =>
      readJson(join(home, '.factory', 'settings.json')).hooks.UserPromptSubmit[0].hooks?.[0].command
  },
  {
    name: 'Command Code',
    script: 'command-code-hook.cmd',
    runners: [CMD_NODE_SHELL],
    stdout: '',
    install: () => new CommandCodeHookService().install(),
    command: (home: string) =>
      readJson(join(home, '.commandcode', 'settings.json')).hooks.Stop[0].hooks?.[0].command
  },
  {
    name: 'Gemini',
    script: 'gemini-hook.cmd',
    runners: [POWERSHELL_GEMINI],
    stdout: '{}',
    install: () => new GeminiHookService().install(),
    command: (home: string) =>
      readJson(join(home, '.gemini', 'settings.json')).hooks.BeforeAgent[0].hooks?.[0].command
  },
  {
    name: 'DSH',
    script: 'dsh-hook.cmd',
    runners: [POWERSHELL_DSH],
    stdout: '',
    install: () => new DshHookService().install(),
    command: (home: string) =>
      readJson(join(home, '.orca', 'agent-hooks', 'dsh-hooks.json')).hooks.UserPromptSubmit[0]
        .hooks?.[0].command
  },
  {
    // Kiro is closed source; cover both shells it could use.
    name: 'Kiro',
    script: 'kiro-hook.cmd',
    runners: [POWERSHELL_PLAIN, CMD_NODE_SHELL],
    stdout: '',
    install: (home: string) => {
      mkdirSync(join(home, '.kiro', 'agents'), { recursive: true })
      writeFileSync(join(home, '.kiro', 'agents', 'mine.json'), JSON.stringify({ name: 'mine' }))
      return new KiroHookService().install()
    },
    command: (home: string) =>
      readJson(join(home, '.kiro', 'agents', 'mine.json')).hooks.userPromptSubmit[0].command
  }
]

type HookPost = { payload: string | null; paneKey: string | null; token: string | null }

async function startHookListener(): Promise<{ server: Server; port: number; posts: HookPost[] }> {
  const posts: HookPost[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      const form = new URLSearchParams(body)
      const token = req.headers['x-orca-agent-hook-token']
      posts.push({
        payload: form.get('payload'),
        paneKey: form.get('paneKey'),
        token: typeof token === 'string' ? token : null
      })
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
  return { server, port, posts }
}

// Why: strip every inherited ORCA_* so an endpoint file from a live Orca can never redirect the
// hook's POST away from this listener.
function hookEnvironment(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('ORCA_'))
  )
  return { ...base, ORCA_BACKGROUND_LAUNCH: '1', ...extra }
}

describe.skipIf(process.platform !== 'win32')('direct .cmd hooks under each agent runner', () => {
  let home = ''
  let server: Server | null = null

  afterEach(() => {
    vi.unstubAllEnvs()
    server?.close()
    server = null
    if (home) {
      removeTreeSync(home)
      home = ''
    }
  })

  it.each(PROVIDERS)(
    '$name delivers the payload byte-exact through its runner',
    async (provider) => {
      home = mkdtempSync(join(tmpdir(), 'orca-direct-cmd-runner-'))
      homedirMock.mockReturnValue(home)
      vi.stubEnv('USERPROFILE', home)
      vi.stubEnv('HOME', home)
      vi.stubEnv('KIRO_HOME', undefined)
      vi.stubEnv('DSH_HOME', undefined)
      // A host cmd AutoRun (HKCU) runs for the .cmd child PowerShell starts without `/d`.
      writeFileSync(join(home, '.cmd_aliases.cmd'), '@echo off\r\n', 'utf8')
      expect(provider.install(home).state).toBe('installed')

      const scriptPath = join(home, '.orca', 'agent-hooks', provider.script)
      expect(WINDOWS_CMD_SAFE_PATH.test(scriptPath), 'test home must be cmd-safe').toBe(true)
      const command = provider.command(home)
      expect(command).toBe(scriptPath.replaceAll('\\', '/'))
      if (!command) {
        throw new Error(`Missing managed ${provider.name} command`)
      }

      const listener = await startHookListener()
      server = listener.server
      const env = hookEnvironment({
        USERPROFILE: home,
        HOME: home,
        ORCA_AGENT_HOOK_PORT: String(listener.port),
        ORCA_AGENT_HOOK_TOKEN: HOOK_TOKEN,
        ORCA_PANE_KEY: PANE_KEY
      })

      for (const runner of provider.runners) {
        const before = listener.posts.length
        const result = await runProcess({
          program: runner.program,
          args: runner.args(command),
          windowsVerbatimArguments: runner.verbatim,
          env,
          input: PAYLOAD,
          timeoutMs: 15_000
        })
        expect(result.timedOut, `${runner.name} timed out`).toBe(false)
        expect(result.code, `${runner.name} exit code; stderr: ${result.stderr}`).toBe(0)
        expect(listener.posts.slice(before), runner.name).toEqual([
          { payload: PAYLOAD, paneKey: PANE_KEY, token: HOOK_TOKEN }
        ])
        expect(result.stdout.trim(), `${runner.name} stdout`).toBe(provider.stdout)
      }
    },
    60_000
  )
})
