import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import { bindSettlePaneSerializer } from './pane-serializer-settle'
import { bindDeferredColdRestoreAndSnapshot } from './deferred-cold-restore-and-snapshot'
import { installSleepingRecordAccess } from './sleeping-record-access'

const fixture = vi.hoisted(() => ({ state: {}, paste: vi.fn(), parsed: vi.fn(async () => {}) }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => fixture.state, setState: vi.fn() } }))
vi.mock('@/lib/pane-manager/pane-terminal-output-scheduler', () => ({
  waitForTerminalOutputParsed: fixture.parsed
}))
vi.mock('../terminal-startup-command-paste', () => ({
  executeTerminalStartupCommandPaste: fixture.paste
}))
vi.mock('../terminal-paste-runtime', () => ({ resolveTerminalPasteRuntime: () => ({}) }))
vi.mock('@/lib/new-workspace', () => ({ CLIENT_PLATFORM: 'win32' }))
vi.mock('./command-inferred-pane-agent', () => ({ installCommandInferredPaneAgent: vi.fn() }))

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('a refused saved startup and its delayed paste', () => {
  it.each(['original', 'same-C', 'different-D', 'unverifiable'] as const)(
    'cancels only its captured source and keeps newer work (%s)',
    async (kind) => {
      vi.useFakeTimers()
      const record = {
        paneKey: 'tab:leaf',
        tabId: 'tab',
        worktreeId: 'wt',
        agent: 'codex' as const,
        providerSession: { key: 'session_id' as const, id: 'C' },
        connectionId: null,
        state: 'done' as const,
        prompt: '',
        capturedAt: 10,
        updatedAt: 10,
        origin: 'worktree-sleep' as const
      }
      const source = { cancelled: false, record }
      const startup = {
        command: 'codex resume C',
        launchAgent: 'codex' as const,
        resumeProviderSession: record.providerSession,
        resumeOrigin: 'saved' as const,
        resumeSource: source
      }
      const records = kind === 'unverifiable' ? {} : { [record.paneKey]: record }
      const clear = vi.fn()
      const remember = vi.fn()
      fixture.state = {
        sleepingAgentSessionsByPaneKey: records,
        automaticAgentResumeClaimsByTabId: {},
        agentLaunchConfigByPaneKey: {},
        pendingStartupByTabId: {},
        tabsByWorktree: {},
        registerAgentLaunchConfig: vi.fn(),
        clearAgentLaunchConfig: vi.fn(),
        consumeTabStartupCommand: vi.fn(),
        clearSleepingAgentSession: clear,
        rememberSleepingAgentSession: remember
      }
      const sendInput = vi.fn(() => true)
      const transport = { getPtyId: () => 'shell', sendInput }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the installers' accessed session members are supplied here.
      const session = {
        pane: { id: 1, leafId: 'leaf', terminal: {} },
        manager: {},
        transport,
        deps: {
          worktreeId: 'wt',
          tabId: 'tab',
          paneTransportsRef: { current: new Map([[1, transport]]) }
        },
        cacheKey: record.paneKey,
        paneStartup: startup,
        startupInjectTimer: null,
        disposed: false,
        transportStreamGeneration: 1,
        shouldDeliverStartupViaTerminalPaste: true,
        releaseUnattemptedStartupDraftPasteDelivery: vi.fn()
      } as unknown as ConnectPanePtySession
      installSleepingRecordAccess(session)
      bindSettlePaneSerializer(session)
      bindDeferredColdRestoreAndSnapshot(session)
      let finishPaste: (() => void) | undefined
      fixture.paste.mockImplementation(
        () =>
          new Promise((resolve) => {
            finishPaste = () => resolve({ status: 'pasted' })
          })
      )
      session.schedulePendingStartupCommandDelivery()
      await vi.advanceTimersByTimeAsync(50)
      expect(fixture.paste).toHaveBeenCalledOnce()

      const newer = { command: kind === 'different-D' ? 'codex resume D' : 'codex resume C' }
      session.pendingStartupCommand = newer
      if (kind === 'same-C' || kind === 'different-D') {
        Object.assign(records, {
          [record.paneKey]: {
            ...record,
            providerSession: { ...record.providerSession, id: kind === 'same-C' ? 'C' : 'D' },
            updatedAt: 20
          }
        })
      }
      session.cancelSavedResumeStartup(startup, {
        id: 'shell',
        agentResumeRefused: kind === 'unverifiable' ? 'unverifiable' : 'chat-home'
      })
      expect(source.cancelled).toBe(true)
      expect(session.pendingStartupCommand).toBe(newer)
      finishPaste?.()
      await vi.advanceTimersByTimeAsync(0)
      expect(sendInput).not.toHaveBeenCalled()
      expect(session.pendingStartupCommand).toBe(newer)
      if (kind === 'unverifiable') {
        expect(remember).toHaveBeenCalledWith(record)
      } else if (kind === 'original') {
        expect(clear).toHaveBeenCalledWith(record.paneKey)
      } else {
        expect(clear).not.toHaveBeenCalled()
      }
    }
  )
})
