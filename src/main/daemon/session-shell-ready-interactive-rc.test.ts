import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createPtySubprocess } from './pty-subprocess'
import { Session } from './session'

const STARTUP_OUTPUT = 'ORCA_STARTUP_COMMAND_RAN'
const SECRET = 'hunter2'
// A startup file that asks for a passphrase before the shell can reach its prompt, the shape a
// `keychain`/`ssh-add` hook has.
const PASSPHRASE_PROMPT = `printf 'Enter passphrase: '; read -rs PASS; printf '\\nRC_GOT:%s\\n' "$PASS"\n`

const SHELLS = [
  { shellPath: '/bin/zsh', startupFile: '.zshrc', prompt: PASSPHRASE_PROMPT },
  { shellPath: '/bin/bash', startupFile: '.bash_profile', prompt: PASSPHRASE_PROMPT },
  {
    shellPath: '/bin/zsh',
    startupFile: '.zshrc',
    prompt: `PASS=''; vared -p 'Enter passphrase: ' PASS; print -r -- "RC_GOT:$PASS"\n`
  },
  { shellPath: '/bin/zsh', startupFile: '.zshrc', prompt: `unsetopt zle\n${PASSPHRASE_PROMPT}` },
  {
    shellPath: '/bin/bash',
    startupFile: '.bash_profile',
    prompt: `read -erp 'Enter passphrase: ' PASS; printf '\\nRC_GOT:%s\\n' "$PASS"\n`
  },
  {
    shellPath: process.platform === 'darwin' ? '/opt/homebrew/bin/fish' : '/usr/bin/fish',
    startupFile: '.config/fish/config.fish',
    prompt: `read -s -P 'Enter passphrase: ' PASS; printf '\\nRC_GOT:%s\\n' "$PASS"\n`
  }
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
  shellReadyTimeoutMs: number,
  prompt: string,
  command = `printf 'ORCA_STARTUP_%s\\n' COMMAND_RAN\r`
): Promise<{ session: Session; output: () => string; cleanup: () => Promise<void> }> {
  const tempHome = mkdtempSync(join(tmpdir(), 'orca-zsh-interactive-init-restore-'))
  mkdirSync(dirname(join(tempHome, startupFile)), { recursive: true })
  writeFileSync(join(tempHome, startupFile), prompt)
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const subprocess = await createPtySubprocess({
    sessionId: `interactive-rc-${startupFile}`,
    cols: 80,
    rows: 24,
    cwd: tempHome,
    command,
    shellOverride: shellPath,
    env: {
      HOME: tempHome,
      XDG_CONFIG_HOME: join(tempHome, '.config'),
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
  expect(subprocess.startupCommandDeliveredByWrapper).toBe(true)
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
  'startup file that prompts before the shell is ready ($shellPath $prompt)',
  ({ shellPath, startupFile, prompt }) => {
    it.each([false, true])(
      'answers startup questions and executes once (past deadline: %s)',
      async (pastDeadline) => {
        const running = await startShell(
          shellPath,
          startupFile,
          pastDeadline ? 500 : 15_000,
          prompt
        )
        try {
          await waitFor(() => running.output().includes('Enter passphrase:'), 5_000)
          if (pastDeadline) {
            await new Promise((resolve) => setTimeout(resolve, 1_000))
            expect(running.output()).not.toContain(STARTUP_OUTPUT)
          }
          running.session.write(`${SECRET}\r`)
          await waitFor(() => running.output().includes(STARTUP_OUTPUT), 5_000).catch((error) => {
            throw new Error(
              `${error}\n${JSON.stringify(running.output())}\nstate=${running.session.shellState}`
            )
          })
          expect(running.output()).toContain(`RC_GOT:${SECRET}`)
          expect(running.session.shellState).toBe('ready')
          expect(running.output().split(STARTUP_OUTPUT).length - 1).toBe(1)
        } finally {
          await running.cleanup()
        }
      },
      20_000
    )
  }
)

// The command body can exceed exec's per-environment-string limit without creating a large argv.
it.skipIf(process.platform === 'win32')(
  'runs a staged large command after the startup question',
  async () => {
    const running = await startShell(
      '/bin/bash',
      '.bash_profile',
      15_000,
      PASSPHRASE_PROMPT,
      `# ${'x'.repeat(200_000)}\nprintf 'ORCA_STARTUP_%s\\n' COMMAND_RAN`
    )
    try {
      await waitFor(() => running.output().includes('Enter passphrase:'), 5_000)
      running.session.write(`${SECRET}\r`)
      await waitFor(() => running.output().includes(STARTUP_OUTPUT), 5_000)
      expect(running.output()).toContain(`RC_GOT:${SECRET}`)
      expect(running.output().split(STARTUP_OUTPUT).length - 1).toBe(1)
    } finally {
      await running.cleanup()
    }
  },
  20_000
)
