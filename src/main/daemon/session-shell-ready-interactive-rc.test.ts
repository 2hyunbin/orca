import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createPtySubprocess } from './pty-subprocess'
import { Session } from './session'

const STARTUP_OUTPUT = 'ORCA_STARTUP_COMMAND_RAN'
const SECRET = 'hunter2'
// A startup file that asks for a passphrase before the shell can reach its prompt, the shape a
// `keychain`/`ssh-add` hook has.
const PASSPHRASE_PROMPT = `printf 'Enter passphrase: '; read -rs PASS; printf '\\nRC_GOT:%s\\n' "$PASS"\n`

const SHELLS = [
  { shellPath: '/bin/zsh', startupFile: '.zshrc' },
  { shellPath: '/bin/bash', startupFile: '.bash_profile' }
].filter(
  ({ shellPath }) =>
    process.platform !== 'win32' && spawnSync(shellPath, ['--version']).status === 0
)

async function waitFor(isDone: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!isDone()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for PTY output')
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function startShell(
  shellPath: string,
  startupFile: string,
  shellReadyTimeoutMs: number
): Promise<{ session: Session; output: () => string; cleanup: () => Promise<void> }> {
  const tempHome = mkdtempSync(join(tmpdir(), 'orca-zsh-interactive-init-restore-'))
  writeFileSync(join(tempHome, startupFile), PASSPHRASE_PROMPT)
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const command = `printf 'ORCA_STARTUP_%s\\n' COMMAND_RAN\r`
  const subprocess = await createPtySubprocess({
    sessionId: `interactive-rc-${startupFile}`,
    cols: 80,
    rows: 24,
    cwd: tempHome,
    command,
    shellOverride: shellPath,
    env: {
      HOME: tempHome,
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      SHELL: shellPath,
      TERM: 'xterm-256color'
    },
    envToDelete: ['ZDOTDIR', 'ORCA_ORIG_ZDOTDIR']
  })
  const session = new Session({
    sessionId: `interactive-rc-${startupFile}`,
    cols: 80,
    rows: 24,
    subprocess,
    shellReadySupported: true,
    shellReadyTimeoutMs
  })
  let output = ''
  session.attachClient({ onData: (data) => (output += data), onExit: () => {} })
  session.writeStartupCommand(command)
  return {
    session,
    output: () => output,
    cleanup: async () => {
      try {
        await session.forceKillAndWaitForExit(3_000)
      } catch {}
      session.dispose()
      warnSpy.mockRestore()
      rmSync(tempHome, { recursive: true, force: true })
    }
  }
}

describe.each(SHELLS)(
  'startup file that prompts before the shell is ready ($startupFile)',
  ({ shellPath, startupFile }) => {
    it('the passphrase typed into the prompt reaches it, and the startup command runs once after', async () => {
      const running = await startShell(shellPath, startupFile, 15_000)
      try {
        await waitFor(() => running.output().includes('Enter passphrase:'), 5_000)
        running.session.write(`${SECRET}\r`)
        await waitFor(() => running.output().includes(STARTUP_OUTPUT), 5_000).catch((error) => {
          throw new Error(
            `${error}\n${JSON.stringify(running.output())}\nstate=${running.session.shellState}`
          )
        })
        expect(running.output()).toContain(`RC_GOT:${SECRET}`)
      } finally {
        await running.cleanup()
      }
    }, 20_000)

    it('a prompt left unanswered past the ready timeout does not receive the startup command', async () => {
      const running = await startShell(shellPath, startupFile, 500)
      try {
        await waitFor(() => running.output().includes('Enter passphrase:'), 5_000)
        await new Promise((resolve) => setTimeout(resolve, 1_000))
        running.session.write(`${SECRET}\r`)
        await waitFor(() => running.output().includes(STARTUP_OUTPUT), 5_000).catch((error) => {
          throw new Error(
            `${error}\n${JSON.stringify(running.output())}\nstate=${running.session.shellState}`
          )
        })
        expect(running.output()).toContain(`RC_GOT:${SECRET}`)
      } finally {
        await running.cleanup()
      }
    }, 20_000)
  }
)
