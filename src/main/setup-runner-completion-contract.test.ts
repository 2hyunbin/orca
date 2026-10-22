import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { expect, it } from 'vitest'
import { makeHookTestRepo } from './hooks-test-fixtures'
import { createSetupRunnerScript } from './worktree-runner-script'
import { createSequencedSetupAgentCommands } from '../shared/setup-agent-sequencing'
import { createSetupCompletionScanner } from './runtime/orchestration/setup-completion-signal'

it.skipIf(process.platform === 'win32')(
  'observes caller-wrapped setup without replacing user exit traps or exiting the parent shell',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-31255-setup-'))
    try {
      const checkout = join(root, 'checkout')
      const initialized = await runProcess({
        program: 'git',
        args: ['init', '-q', '--separate-git-dir', join(root, 'metadata'), checkout]
      })
      expect(initialized.code, initialized.stderr).toBe(0)
      const setup = createSetupRunnerScript(
        makeHookTestRepo(),
        checkout,
        'trap \'printf "user-trap\\n"\' EXIT\nexit 17'
      )
      const wrapped = createSequencedSetupAgentCommands({
        runnerScriptPath: setup.runnerScriptPath,
        startupCommand: 'unused',
        platform: 'posix'
      })
      const result = await runProcess({
        program: 'bash',
        args: ['-c', `${wrapped.setupCommand}; printf 'parent-alive\\n'`],
        cwd: checkout,
        env: { ...process.env, ...setup.envVars, HOME: root },
        timeoutMs: 10_000
      })
      expect(result.code, result.stderr).toBe(0)
      expect(result.stdout).toContain('user-trap')
      expect(result.stdout).toContain('parent-alive')
      let status: number | undefined
      createSetupCompletionScanner(setup.envVars.ORCA_SETUP_COMPLETION_TOKEN, (value) => {
        status = value
      }).scan(result.stdout)
      expect(status).toBe(17)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)
