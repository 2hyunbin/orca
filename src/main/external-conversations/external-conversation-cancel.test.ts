import { describe, expect, it, vi } from 'vitest'
import { buildAgentTuiClearInputForText } from '../../shared/agent-tui-input-clear'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import type { AgentPaneChange } from '../agent-hooks/agent-transition-detector'
import type { ConversationEvent } from './external-conversation-events'
import type { ConversationKey } from './external-conversation-types'
import {
  fakeLauncher,
  fakeTerminal,
  launchResult,
  PANE,
  WORKTREE
} from './external-conversation.test-fixture'
import { deferred, harness } from './external-conversation-seam.test-fixture'

const KEY: ConversationKey = { source: 'dev', externalId: 'thread-1' }
const START = {
  agent: 'claude',
  target: { kind: 'existing' as const, worktree: `id:${WORKTREE}` },
  prompt: 'first'
}

function hookRow(overrides: Partial<AgentStatusIpcPayload> = {}): AgentStatusIpcPayload {
  return {
    state: 'working',
    prompt: '',
    agentType: 'claude',
    paneKey: PANE,
    connectionId: null,
    receivedAt: 1,
    stateStartedAt: 100,
    ...overrides
  }
}

const APPROVAL = hookRow({
  state: 'waiting',
  stateStartedAt: 200,
  interactivePrompt: JSON.stringify({ approval: { tool: 'Bash', summary: 'ls' } })
})

async function linked(settings = {}) {
  const h = harness(settings)
  const fake = fakeTerminal()
  const host = {
    launcher: fakeLauncher(async () => launchResult('handed-to-terminal')).launcher,
    terminal: fake.terminal
  }
  await h.seam.start(host, KEY, 'd1', START)
  return { ...h, fake, host }
}

describe('ExternalConversationSeam cancel', () => {
  it('interrupts a working agent with one Escape, once per delivery id', async () => {
    const { seam, host, hookRows, fake } = await linked()
    hookRows.set(PANE, hookRow())
    await expect(seam.cancel(host, KEY, 'c1')).resolves.toEqual({ outcome: 'accepted' })
    expect(fake.keys).toEqual(['\x1b'])
    await expect(seam.cancel(host, KEY, 'c1')).resolves.toEqual({ outcome: 'accepted' })
    expect(fake.keys).toEqual(['\x1b'])
  })

  it('leaves an idle agent alone, and a retry of that cancel never interrupts a later turn', async () => {
    const { seam, host, hookRows, fake } = await linked()
    hookRows.set(PANE, hookRow({ state: 'done' }))
    await expect(seam.cancel(host, KEY, 'c1')).resolves.toEqual({ outcome: 'accepted' })
    hookRows.set(PANE, hookRow({ stateStartedAt: 300 }))
    await expect(seam.cancel(host, KEY, 'c1')).resolves.toEqual({ outcome: 'accepted' })
    expect(fake.keys).toEqual([])
  })

  it('does not receipt missing status as idle, so reconnecting status permits a retry', async () => {
    const { seam, host, hookRows, fake } = await linked()
    hookRows.delete(PANE)
    await expect(seam.cancel(host, KEY, 'c1')).resolves.toEqual({
      outcome: 'refused',
      reason: 'agent_not_reachable'
    })
    hookRows.set(PANE, hookRow())
    await expect(seam.cancel(host, KEY, 'c1')).resolves.toEqual({ outcome: 'accepted' })
    expect(fake.keys).toEqual(['\x1b'])
  })

  it('rejects a pending approval through the prompt answer, and refuses a question', async () => {
    const { seam, host, hookRows, fake } = await linked()
    hookRows.set(PANE, APPROVAL)
    await expect(seam.cancel(host, KEY, 'c1')).resolves.toEqual({ outcome: 'accepted' })
    expect(fake.keys).toEqual(['\x1b'])
    expect(seam.pendingPrompt(host, KEY)).toBeNull()
    hookRows.set(
      PANE,
      hookRow({
        state: 'waiting',
        stateStartedAt: 400,
        toolName: 'AskUserQuestion',
        interactivePrompt: JSON.stringify({
          questions: [
            { question: 'Which?', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false }
          ]
        })
      })
    )
    const prompt = seam.pendingPrompt(host, KEY)
    expect(prompt?.kind).not.toBe('approval')
    await expect(seam.cancel(host, KEY, 'c2')).resolves.toEqual({
      outcome: 'refused',
      reason: 'prompt_unsupported'
    })
    expect(fake.keys).toEqual(['\x1b'])
  })

  it('settles held and queued follow-ups unwritten before rejecting the approval they wait on', async () => {
    const { seam, host, hookRows, fake } = await linked()
    hookRows.set(PANE, APPROVAL)
    fake.state.blocked = true
    const held = seam.send(host, KEY, 's1', 'held')
    const queued = seam.send(host, KEY, 's2', 'queued')
    await vi.waitFor(() => expect(fake.held()).toBe(1))
    await expect(seam.cancel(host, KEY, 'c1')).resolves.toEqual({ outcome: 'accepted' })
    const cancelled = { outcome: 'refused', reason: 'conversation_cancelled' }
    await expect(held).resolves.toEqual(cancelled)
    await expect(queued).resolves.toEqual(cancelled)
    fake.answer()
    expect(fake.writes).toEqual([])
    expect(fake.keys).toEqual(['\x1b'])
    // Refusals leave no receipt, and a later send opens a fresh lane.
    hookRows.set(PANE, hookRow({ state: 'done' }))
    await expect(seam.send(host, KEY, 's1', 'held')).resolves.toEqual({ outcome: 'accepted' })
    expect(fake.writes).toEqual(['held'])
  })

  it('settles a start not yet linked, and throws for a conversation it never saw', async () => {
    const h = harness()
    const fake = fakeTerminal()
    const launcher = fakeLauncher(async () => launchResult(null), undefined, false)
    // As the real launcher: an abort before the surface is published throws.
    launcher.launch.mockImplementation(
      (_input, _onPublished, signal) =>
        new Promise((_resolve, reject) =>
          signal?.addEventListener('abort', () => reject(new Error('request_aborted')))
        )
    )
    const host = { launcher: launcher.launcher, terminal: fake.terminal }
    const started = h.seam.start(host, KEY, 'd1', START)
    await vi.waitFor(() => expect(launcher.launch).toHaveBeenCalledTimes(1))
    await expect(h.seam.cancel(host, KEY, 'c1')).resolves.toEqual({ outcome: 'accepted' })
    await expect(started).resolves.toMatchObject({
      initial: { outcome: 'refused', reason: 'conversation_cancelled' }
    })
    await expect(h.seam.cancel(host, { source: 'dev', externalId: 'nope' }, 'c2')).rejects.toThrow(
      'external_conversation_not_found'
    )
  })

  it('waits for a published agent to be linked, then stops it', async () => {
    const h = harness()
    const fake = fakeTerminal()
    const linking = deferred<{ worktreeId: string; sshHostId: null }>()
    const { launcher, launch } = fakeLauncher(async () => launchResult('handed-to-terminal'))
    const host = {
      launcher: { ...launcher, paneWorkspace: () => linking.promise },
      terminal: fake.terminal
    }
    const started = h.seam.start(host, KEY, 'd1', START)
    await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1))
    h.hookRows.set(PANE, hookRow())
    let settled = false
    const cancelled = h.seam.cancel(host, KEY, 'c1').finally(() => {
      settled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(settled).toBe(false)
    linking.resolve({ worktreeId: WORKTREE, sshHostId: null })
    await expect(cancelled).resolves.toEqual({ outcome: 'accepted' })
    expect(fake.keys).toEqual(['\x1b'])
    await started
  })

  it('refuses, unrecorded, while the host is out of contact or a shell is in front', async () => {
    const { seam, host, hookRows, fake } = await linked()
    hookRows.set(PANE, hookRow())
    fake.state.liveness = { status: 'unverifiable', reason: 'relay dropped' }
    const unreachable = { outcome: 'refused', reason: 'agent_not_reachable' }
    await expect(seam.cancel(host, KEY, 'c1')).resolves.toEqual(unreachable)
    fake.state.liveness = null
    fake.terminal.readLaunchedAgentForeground.mockResolvedValueOnce('shell')
    await expect(seam.cancel(host, KEY, 'c1')).resolves.toEqual(unreachable)
    expect(fake.keys).toEqual([])
    await expect(seam.cancel(host, KEY, 'c1')).resolves.toEqual({ outcome: 'accepted' })
    expect(fake.keys).toEqual(['\x1b'])
  })

  it('refuses a delivery id another method used, and everything once connectors are off', async () => {
    const { seam, host, hookRows, fake } = await linked()
    hookRows.set(PANE, hookRow())
    await expect(seam.cancel(host, KEY, 'd1')).resolves.toEqual({
      outcome: 'refused',
      reason: 'delivery_id_reused'
    })
    seam.dispose('connectors_disabled')
    await expect(seam.cancel(host, KEY, 'c1')).resolves.toEqual({
      outcome: 'refused',
      reason: 'connectors_disabled'
    })
    expect(fake.keys).toEqual([])
  })
})

describe('ExternalConversationSeam cancel: what it leaves behind', () => {
  const CLEAR = buildAgentTuiClearInputForText('first')

  async function cancelledEarly() {
    const h = await linked()
    h.hookRows.set(PANE, hookRow())
    await expect(h.seam.cancel(h.host, KEY, 'c1')).resolves.toEqual({ outcome: 'accepted' })
    h.hookRows.set(PANE, hookRow({ state: 'done' }))
    return h
  }

  it('clears the interrupted prompt Claude put back, once, before the next send', async () => {
    const { seam, host, fake } = await cancelledEarly()
    fake.state.draft = 'first'
    await expect(seam.send(host, KEY, 's1', 'next')).resolves.toEqual({ outcome: 'accepted' })
    expect(fake.keys).toEqual(['\x1b', CLEAR])
    expect(fake.writes).toEqual(['next'])
    await seam.send(host, KEY, 's2', 'again')
    expect(fake.keys).toEqual(['\x1b', CLEAR])
  })

  it('pastes nothing after a clear that may have half-landed, and keeps the mark for the next send', async () => {
    const { seam, host, fake } = await cancelledEarly()
    fake.state.draft = 'first'
    fake.sendTerminal.mockImplementationOnce(async (_handle, _action, options) => {
      options.reserveWrite?.('pty-1')
      throw new Error('connection_lost')
    })
    await expect(seam.send(host, KEY, 's1', 'next')).resolves.toEqual({
      outcome: 'unknown',
      reason: 'writer_failed'
    })
    expect(fake.writes).toEqual([])
    await expect(seam.send(host, KEY, 's2', 'next')).resolves.toEqual({ outcome: 'accepted' })
    expect(fake.keys).toEqual(['\x1b', CLEAR])
    expect(fake.writes).toEqual(['next'])
  })

  it('touches nothing else in the box: a person’s text, an unread screen, a new process', async () => {
    for (const change of [
      (fake: ReturnType<typeof fakeTerminal>) => (fake.state.draft = 'HUMANTYPED'),
      (fake: ReturnType<typeof fakeTerminal>) => (fake.state.draft = null),
      (fake: ReturnType<typeof fakeTerminal>) => {
        fake.state.draft = 'first'
        fake.replace()
      }
    ]) {
      const { seam, host, fake } = await cancelledEarly()
      change(fake)
      await seam.send(host, KEY, 's1', 'next')
      expect(fake.keys).toEqual(['\x1b'])
    }
  })

  it('never clears after a turn our cancel did not interrupt', async () => {
    const { seam, host, hookRows, fake } = await linked()
    hookRows.set(PANE, hookRow({ state: 'done' }))
    await seam.cancel(host, KEY, 'c1')
    fake.state.draft = 'first'
    await seam.send(host, KEY, 's1', 'next')
    expect(fake.keys).toEqual([])
  })

  it('tells watchers the rejected turn ended once Claude reports idle on that prompt', async () => {
    const { seam, host, hookRows, paneChange } = await linked()
    const events: ConversationEvent[] = []
    seam.watch(host, (event) => {
      if (event.kind !== 'snapshot') {
        events.push(event)
      }
    })
    hookRows.set(PANE, { ...APPROVAL, programStatus: { state: 'blocked', observedAt: 1 } })
    await expect(seam.cancel(host, KEY, 'c1')).resolves.toEqual({ outcome: 'accepted' })
    paneChange(observed())
    expect(events).toEqual([])
    hookRows.set(PANE, { ...APPROVAL, programStatus: { state: 'idle', observedAt: Date.now() } })
    paneChange(observed())
    paneChange(observed())
    expect(events).toEqual([
      expect.objectContaining({ kind: 'turn-ended', stopReason: 'cancellation', paneKey: PANE })
    ])
  })

  it('leaves the turn to the host’s own news once its row moves past the rejected prompt', async () => {
    const { seam, host, hookRows, paneChange } = await linked()
    const ended: ConversationEvent[] = []
    seam.watch(host, (event) => {
      if (event.kind === 'turn-ended') {
        ended.push(event)
      }
    })
    hookRows.set(PANE, APPROVAL)
    await seam.cancel(host, KEY, 'c1')
    hookRows.set(PANE, hookRow({ state: 'working', stateStartedAt: 500 }))
    paneChange(observed())
    hookRows.set(PANE, {
      ...APPROVAL,
      stateStartedAt: 600,
      programStatus: { state: 'idle', observedAt: Date.now() }
    })
    paneChange(observed())
    expect(ended).toEqual([])
  })
})

function observed(): AgentPaneChange {
  return {
    kind: 'observed',
    paneKey: PANE,
    workspace: { worktreeId: WORKTREE, sshHostId: null },
    phase: 'needs-you',
    at: Date.now()
  }
}
