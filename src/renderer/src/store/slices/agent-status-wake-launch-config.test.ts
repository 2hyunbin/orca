import { describe, expect, it } from 'vitest'
import type { AppState } from '../types'
import { createTestStore, makeTab } from './store-test-helpers'

describe('launch flags across an in-place wake', () => {
  it('keeps saved launch flags on the record across a second sleep and wake', () => {
    const store = createTestStore()
    store.setState({
      tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] }
    } as Partial<AppState>)
    const paneKey = 'tab-1:leaf-1'
    const launchConfig = {
      agentArgs: '--dangerously-skip-permissions',
      agentEnv: { CLAUDE_PROFILE: 'work' }
    }
    const providerSession = { key: 'session_id' as const, id: 'claude-session-1' }
    const runAndSleep = (launchToken: string, wakesFromSleep: boolean) => {
      store.getState().registerAgentLaunchConfig(paneKey, launchConfig, {
        agentType: 'claude',
        launchToken,
        tabId: 'tab-1',
        leafId: 'leaf-1'
      })
      if (wakesFromSleep) {
        // The pane's spawn consumes the sleeping record it woke from.
        store.getState().clearSleepingAgentSession(paneKey)
      }
      store
        .getState()
        .recordAgentProviderSession(
          paneKey,
          'claude',
          providerSession,
          { updatedAt: 20 },
          { tabId: 'tab-1', worktreeId: 'wt-1', connectionId: null },
          { launchToken }
        )
      store.getState().captureSleepingAgentSessionsByWorktree('wt-1', [paneKey])
      store.getState().dropAgentStatusByWorktree('wt-1', {
        shutdownReason: 'manual-sleep',
        sleepingPaneKeys: [paneKey]
      })
      return store.getState().sleepingAgentSessionsByPaneKey[paneKey]
    }

    expect(runAndSleep('launch-1', false)?.launchConfig).toEqual(launchConfig)
    expect(runAndSleep('wake-1', true)?.launchConfig).toEqual(launchConfig)
    expect(runAndSleep('wake-2', true)?.launchConfig).toEqual(launchConfig)
  })
})

describe('sleep capture of a resumed pane before its first launch-token hook', () => {
  const paneKey = 'tab-1:leaf-1'
  const launchConfig = {
    agentArgs: '--ask-for-approval on-request --sandbox read-only',
    agentEnv: {}
  }
  const resumedSession = { key: 'session_id' as const, id: 'codex-session-1' }

  function wakeAndSleep(
    store: ReturnType<typeof createTestStore>,
    args: {
      launchToken: string
      resumedProviderSession: typeof resumedSession | undefined
      reportedSession: typeof resumedSession
    }
  ) {
    store.getState().registerAgentLaunchConfig(paneKey, launchConfig, {
      agentType: 'codex',
      launchToken: args.launchToken,
      tabId: 'tab-1',
      leafId: 'leaf-1',
      ...(args.resumedProviderSession
        ? { resumedProviderSession: args.resumedProviderSession }
        : {})
    })
    store.getState().clearSleepingAgentSession(paneKey)
    // Codex defers its token-bearing SessionStart until the first prompt.
    store
      .getState()
      .setAgentStatus(
        paneKey,
        { state: 'working', prompt: '', agentType: 'codex' },
        'Codex',
        { updatedAt: 10, stateStartedAt: 10 },
        { tabId: 'tab-1', worktreeId: 'wt-1' },
        { providerSession: args.reportedSession }
      )
    store.getState().captureSleepingAgentSessionsByWorktree('wt-1', [paneKey])
    store.getState().dropAgentStatusByWorktree('wt-1', {
      shutdownReason: 'manual-sleep',
      sleepingPaneKeys: [paneKey]
    })
    return store.getState().sleepingAgentSessionsByPaneKey[paneKey]
  }

  function makeStore() {
    const store = createTestStore()
    store.setState({
      tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] }
    } as Partial<AppState>)
    return store
  }

  it('keeps the flags of the session the wake resumed across repeated wakes', () => {
    const store = makeStore()
    for (const launchToken of ['wake-1', 'wake-2']) {
      const record = wakeAndSleep(store, {
        launchToken,
        resumedProviderSession: resumedSession,
        reportedSession: resumedSession
      })
      expect(record?.launchConfig).toEqual(launchConfig)
    }
  })

  it.each([
    { label: 'a launch that resumed nothing', resumedProviderSession: undefined },
    {
      label: 'a different session',
      resumedProviderSession: { key: 'session_id' as const, id: 'other' }
    }
  ])('does not give $label the registered flags', ({ resumedProviderSession }) => {
    const record = wakeAndSleep(makeStore(), {
      launchToken: 'wake-1',
      resumedProviderSession,
      reportedSession: resumedSession
    })
    expect(record?.providerSession).toEqual(resumedSession)
    expect(record?.launchConfig).toBeUndefined()
  })

  it('lets a new session from the resumed launch keep its flags through its token hook', () => {
    const store = makeStore()
    store.getState().registerAgentLaunchConfig(paneKey, launchConfig, {
      agentType: 'codex',
      launchToken: 'wake-1',
      tabId: 'tab-1',
      leafId: 'leaf-1',
      resumedProviderSession: resumedSession
    })
    // The resume did not take (or the user started /new): the process reports another session.
    const newSession = { key: 'session_id' as const, id: 'codex-session-2' }
    store
      .getState()
      .recordAgentProviderSession(
        paneKey,
        'codex',
        newSession,
        { updatedAt: 20 },
        { tabId: 'tab-1', worktreeId: 'wt-1', connectionId: null },
        { launchToken: 'wake-1' }
      )

    expect(store.getState().agentLaunchConfigByPaneKey[paneKey]?.launchConfig).toEqual(launchConfig)
    expect(store.getState().sleepingAgentSessionsByPaneKey[paneKey]).toMatchObject({
      providerSession: newSession,
      launchConfig
    })
  })
})
