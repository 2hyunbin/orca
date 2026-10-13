import { describe, expect, vi } from 'vitest'
import { spawnMock } from './pty-ipc-mock-registry'
import { posixOnlyIt } from './pty-ipc-test-constants'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { POSIX_SHELL_STARTUP_COMMAND_ENV } from '../pty/posix-shell-startup-command'
import { registerPtyHandlers } from './pty/register-handlers'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { AgentSessionRecordStore } from '../runtime/agent-session-record-store'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import { claudeProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import type { AgentSessionRecord } from '../../shared/agent-session-record'

vi.mock('electron', () => import('./pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('./pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node-pty', () => import('./pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../opencode/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../mimo/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../agent-hooks/server', () =>
  import('./pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../pi/titlebar-extension-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../pwsh', () => import('./pty-ipc-mock-registry').then((m) => m.pwshModuleMock()))
vi.mock('../wsl', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).wslModuleMock(await importOriginal())
)
vi.mock('../telemetry/client', () =>
  import('./pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../telemetry/classify-error', () =>
  import('./pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../cli/linux-terminal-orca-cli-shim', () =>
  import('./pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../memory/pty-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../agent-hooks/migration-unsupported-pty-state', () =>
  import('./pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../codex/codex-pane-account-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../codex/codex-state-db-backfill-recovery', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)

describe('registerPtyHandlers', () => {
  const { handlers, mainWindow, createMockProc } = setupPtyIpcSuite()

  describe('a saved resume of a conversation a native chat owns', () => {
    // The incident: a chat's Claude session saved by a floating pane that leaked into the chat.
    const CHAT_SESSION_ID = 'b6bd7d57-2ec3-4e62-a47d-715e2455301d'
    const PANE_SESSION_ID = '2f0c1d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f'

    function chatOwning(providerSessionId: string): AgentSessionRecord {
      const record = agentSessionRecordFixture()
      return {
        ...record,
        location: { ...record.location, workspaceId: 'structured-chat-default' },
        providerHandleChain: [
          {
            ...record.providerHandleChain[0]!,
            handle: claudeProviderHandle(providerSessionId, null)
          }
        ]
      }
    }

    function registerWithChats(listRecords: () => AgentSessionRecord[]) {
      const runtime = new OrcaRuntimeService()
      vi.spyOn(runtime, 'openAgentSessionRecordStore').mockImplementation(async () => {
        const store: AgentSessionRecordStore = Object.create(AgentSessionRecordStore.prototype)
        store.listRecords = listRecords
        return store
      })
      registerPtyHandlers(mainWindow, runtime)
    }

    type SpawnedShell = {
      ownedByChat: boolean
      resumeUnavailable: boolean
      /** Everything the shell is told to run: its startup variable and what is typed in. */
      input: string
      env: Record<string, string>
    }

    async function spawnClaudeResume(providerSessionId: string): Promise<SpawnedShell> {
      const mockProc = createMockProc()
      spawnMock.mockReturnValue(mockProc.proc)
      vi.useFakeTimers()
      try {
        const result = await handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          cwd: '/tmp',
          command: `claude --resume '${providerSessionId}'`,
          launchAgent: 'claude',
          resumeProviderSession: { key: 'session_id', id: providerSessionId }
        })
        for (let flush = 0; flush < 3; flush += 1) {
          await Promise.resolve()
          vi.runAllTimers()
        }
        const env: Record<string, string> = spawnMock.mock.calls.at(-1)![2].env
        const typed = mockProc.proc.write.mock.calls.map((call) => String(call[0]))
        const reported = typeof result === 'object' && result !== null ? result : {}
        return {
          ownedByChat: 'agentResumeOwnedByChat' in reported,
          resumeUnavailable: 'agentResumeUnavailable' in reported,
          input: [env[POSIX_SHELL_STARTUP_COMMAND_ENV] ?? '', ...typed].join('\n'),
          env
        }
      } finally {
        vi.useRealTimers()
      }
    }

    posixOnlyIt('starts the plain shell and says the old session is unavailable', async () => {
      registerWithChats(() => [chatOwning(CHAT_SESSION_ID)])

      const spawned = await spawnClaudeResume(CHAT_SESSION_ID)

      expect(spawned.resumeUnavailable).toBe(true)
      expect(spawned.ownedByChat).toBe(true)
      expect(spawned.input).not.toContain(CHAT_SESSION_ID)
      // A plain shell, not an unattended agent's: Git may prompt for credentials again.
      expect(spawned.env.GIT_TERMINAL_PROMPT).toBeUndefined()
    })

    posixOnlyIt('resumes a conversation no chat owns', async () => {
      registerWithChats(() => [chatOwning(CHAT_SESSION_ID)])

      const spawned = await spawnClaudeResume(PANE_SESSION_ID)

      expect(spawned.resumeUnavailable).toBe(false)
      expect(spawned.ownedByChat).toBe(false)
      expect(spawned.input).toContain(`--resume '${PANE_SESSION_ID}'`)
      expect(spawned.env.GIT_TERMINAL_PROMPT).toBe('0')
    })

    posixOnlyIt('resumes when the chat journal cannot be read', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      registerWithChats(() => {
        throw new Error('journal unavailable')
      })

      const spawned = await spawnClaudeResume(CHAT_SESSION_ID)

      expect(spawned.resumeUnavailable).toBe(false)
      expect(spawned.input).toContain(`--resume '${CHAT_SESSION_ID}'`)
    })
  })
})
