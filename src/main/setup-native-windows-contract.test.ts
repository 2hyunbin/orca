import { spawnShellWithFallback } from './providers/local-pty-utils'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { runProcess } from '@orca/process-host'
import { expect, it } from 'vitest'
import { resolveWindowsShellLaunchArgs } from './providers/windows-shell-args'
import { buildWindowsPowerShellSpawnAttempts } from './providers/windows-shell-fallback-chain'
import { buildSetupRunnerCommand } from '../shared/setup-runner-command'
import {
  appendNativeSetupCompletion,
  createSetupCompletionScanner,
  nativeSetupCompletionShell,
  stripNativeSetupCompletionEnvironment
} from './runtime/orchestration/setup-completion-signal'

it.skipIf(process.platform !== 'win32')(
  'executes native cmd and PowerShell argv/stdin and fallback setup with exact status, guarded path and live parent',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-31255-native-'))
    const system = process.env.SystemRoot ?? 'C:\\Windows'
    const cmd = join(system, 'System32', 'cmd.exe')
    const powershell = join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const killtree = process.env.ORCA_QA_KILLTREE
    expect(
      killtree && isAbsolute(killtree) && existsSync(killtree),
      'root must supply absolute admitted qa-killtree.ps1'
    ).toBeTruthy()
    const env = {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_DATA_HOME: join(root, 'data'),
      XDG_CACHE_HOME: join(root, 'cache'),
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CODEX_HOME: join(root, 'codex'),
      ORCA_E2E_USER_DATA_DIR: join(root, 'orca'),
      ORCA_E2E_HOME_DIR: root,
      ORCA_BACKGROUND_LAUNCH: '1',
      ORCA_DISABLE_MACOS_LOGIN_SHELL: '1',
      ORCA_SETUP_COMPLETION_TOKEN: 'native:windows-contract'
    }
    stripNativeSetupCompletionEnvironment(env)
    const { spawn } = await import('node-pty')
    try {
      const guarded = join(root, 'space & percent% bang!')
      await mkdir(guarded)
      for (const status of [0, 17]) {
        const path = join(guarded, 'setup.cmd')
        await writeFile(
          path,
          `@echo off\r\necho body:%cd%:token=%ORCA_SETUP_COMPLETION_TOKEN%\r\nexit /b ${status}\r\n`
        )
        await writeFile(join(root, 'plain.cmd'), `@exit /b ${status}\r\n`)
        const commands = [
          buildSetupRunnerCommand(path, 'windows'),
          'cmd.exe /c plain.cmd',
          `cmd.exe /c plain.cmd${' '.repeat(6100)}`
        ]
        for (const route of [cmd, powershell, 'fallback']) {
          const shell = route === 'fallback' ? cmd : route
          for (const command of commands) {
            const token = `native:windows-${status}-${shell === cmd ? 'cmd' : 'ps'}`
            const resolved = resolveWindowsShellLaunchArgs(
              shell,
              root,
              root,
              undefined,
              command,
              undefined,
              token
            )
            // No personal profile is opened by this isolated process fixture.
            const args =
              shell === powershell
                ? ['-NoProfile', ...resolved.shellArgs]
                : ['/d', ...resolved.shellArgs]
            const proc =
              route === 'fallback'
                ? spawnShellWithFallback({
                    shellPath: join(root, 'absent-pwsh.exe'),
                    shellArgs: [],
                    cols: 200,
                    rows: 40,
                    cwd: root,
                    env,
                    ptySpawn: spawn,
                    windowsFallbackAttempts: [
                      {
                        shellPath: join(root, 'absent-pwsh.exe'),
                        shellArgs: [],
                        effectiveCwd: root,
                        validationCwd: root,
                        startupCommandDeliveredInShellArgs: false
                      },
                      {
                        shellPath: shell,
                        shellArgs: args,
                        effectiveCwd: root,
                        validationCwd: root,
                        startupCommandDeliveredInShellArgs:
                          resolved.startupCommandDeliveredInShellArgs === true
                      }
                    ]
                  }).process
                : spawn(shell, args, {
                    cwd: resolved.effectiveCwd,
                    env,
                    cols: 200,
                    rows: 40
                  })
            const startedPromise = runProcess({
              program: powershell,
              args: [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                `(Get-Process -Id ${proc.pid}).StartTime.ToUniversalTime().ToString('o')`
              ],
              env
            })
            let exited = false
            let output = ''
            let sent = resolved.startupCommandDeliveredInShellArgs === true
            let checked = false
            let code: number | undefined
            const scanner = createSetupCompletionScanner(token, (value) => {
              code = value
            })
            const completion = new Promise<void>((resolve, reject) => {
              proc.onExit(() => {
                exited = true
                resolve()
              })
              proc.onData((data) => {
                output += data
                scanner.scan(data)
                if (!sent && (output.includes('>') || output.includes(']133;B'))) {
                  sent = true
                  const native = appendNativeSetupCompletion(
                    command,
                    token,
                    nativeSetupCompletionShell(shell)
                  )
                  expect(native.startsWith(command)).toBe(true)
                  proc.write(`${native}\r`)
                }
                if (code !== undefined && !checked) {
                  checked = true
                  proc.write(
                    shell === cmd ? 'echo parent-alive\r' : "[Console]::WriteLine('parent-alive')\r"
                  )
                }
                if (checked && /(?:^|\r?\n)parent-alive\r?\n/.test(output)) {
                  proc.write('exit\r')
                }
              })
              setTimeout(
                () => reject(new Error(`native shell completion timeout: ${output}`)),
                20_000
              ).unref()
            })
            const started = await startedPromise
            const startedAt = started.stdout.trim()
            try {
              await completion
              expect(code, output).toBe(status)
              expect(output).toContain('parent-alive')
              if (command === commands[0]) {
                expect(output).toContain(`body:${root}:token=`)
                expect(output).not.toContain('token=native:')
              }
            } finally {
              if (!exited) {
                expect(startedAt).not.toBe('')
                await runProcess({
                  program: powershell,
                  args: [
                    '-NoProfile',
                    '-File',
                    killtree!,
                    '-RootPid',
                    String(proc.pid),
                    '-RootStarted',
                    startedAt,
                    '-Image',
                    shell
                  ],
                  env
                })
              }
            }
          }
        }
      }
      const attempts = buildWindowsPowerShellSpawnAttempts({
        shellPath: powershell,
        cwd: root,
        defaultCwd: root,
        startupCommand: 'cmd.exe /c plain.cmd',
        nativeSetupToken: 'native:fallback',
        resolveOptions: { platform: 'win32', env, isRealExecutable: (p) => p === powershell }
      })
      expect(attempts.map((a) => nativeSetupCompletionShell(a.shellPath))).toEqual([
        'powershell',
        'cmd'
      ])
      expect(Buffer.from(attempts[0].shellArgs.at(-1)!, 'base64').toString('utf16le')).toContain(
        'native:fallback'
      )
      expect(attempts[1].shellArgs.join(' ')).toContain('%%errorlevel%%')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  120_000
)
