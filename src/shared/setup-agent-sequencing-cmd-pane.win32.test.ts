import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, it } from 'vitest'

import { createSequencedSetupAgentCommands } from './setup-agent-sequencing'
import { buildShellCommandFromArgv } from './tui-agent-startup-shell'

const TEMP_DIRS: string[] = []

afterEach(() => {
  for (const dir of TEMP_DIRS.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

// Why: on a cmd.exe pane the gate only waits; cmd itself must read the cmd-quoted agent command.
describe.runIf(process.platform === 'win32')('setup gate on a cmd.exe pane', () => {
  const runGatedAgent = async (setupExitCode: number) => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-cmd pane gate '))
    TEMP_DIRS.push(dir)
    const runnerScriptPath = join(dir, 'setup runner.cmd')
    const agentScript = join(dir, 'agent.js')
    writeFileSync(runnerScriptPath, `@echo off\r\nexit /b ${setupExitCode}\r\n`, 'utf8')
    writeFileSync(agentScript, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')
    const commands = createSequencedSetupAgentCommands({
      runnerScriptPath,
      startupCommand: buildShellCommandFromArgv(
        [process.execPath, agentScript, 'two words', '--flag=value'],
        'cmd'
      ),
      startupShell: 'cmd',
      platform: 'windows',
      nonce: 'cmd-pane-gate',
      waitTimeoutSeconds: 2
    })
    await runLikeCmdPane(dir, commands.setupCommand)
    return runLikeCmdPane(dir, commands.startupCommand, commands.startupEnv)
  }

  it('hands the agent its arguments intact once setup succeeds', async () => {
    const startup = await runGatedAgent(0)
    expect(startup.code).toBe(0)
    expect(startup.stdout).toContain(JSON.stringify(['two words', '--flag=value']))
  }, 30_000)

  it('skips the agent when setup fails', async () => {
    const startup = await runGatedAgent(37)
    expect(startup.stderr).toContain('Setup failed; skipping agent startup.')
    expect(startup.stdout).not.toContain('two words')
  }, 30_000)
})

/** The pane's `cmd.exe /K "chcp 65001 > nul & <line>"`, with /C so it exits; no batch file. */
function runLikeCmdPane(cwd: string, line: string, env: Record<string, string> = {}) {
  const child = spawn('cmd.exe', ['/d', '/s', '/c', `"chcp 65001 > nul & ${line}"`], {
    cwd,
    windowsVerbatimArguments: true,
    env: { ...process.env, ...env }
  })
  const output = { stdout: '', stderr: '' }
  child.stdout.on('data', (chunk: Buffer) => (output.stdout += chunk.toString()))
  child.stderr.on('data', (chunk: Buffer) => (output.stderr += chunk.toString()))
  return new Promise<typeof output & { code: number | null }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code: number | null) => resolve({ code, ...output }))
  })
}
