import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildAgentTuiClearInputForText } from '../../shared/agent-tui-input-clear'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { writeRefused } from '../../shared/pty-write-settlement'
import { hostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'
import { ExternalConversationSeam } from './external-conversation-seam'
import type { ConversationKey } from './external-conversation-types'
import {
  fakeLauncher,
  fakeLinkStore,
  fakeTerminal,
  launchResult,
  PANE,
  WORKTREE
} from './external-conversation.test-fixture'

const KEY: ConversationKey = { source: 'dev', externalId: 'thread-1' }
const TARGET = { kind: 'existing' as const, worktree: `id:${WORKTREE}` }
const START = { agent: 'claude', target: TARGET, prompt: 'first' }

function harness(settings: Partial<GlobalSettings> = {}) {
  const records = fakeLinkStore()
  const releaseInvalidations = vi.fn()
  const seam = new ExternalConversationSeam({
    store: records.store,
    readSettings: () => settings,
    subscribeInvalidations: () => releaseInvalidations
  })
  return { ...records, seam, releaseInvalidations }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('ExternalConversationSeam start', () => {
  it.each([
    ['handed-to-terminal', { outcome: 'accepted' }],
    ['not-delivered', { outcome: 'unknown', reason: 'launch_outcome_unknown' }],
    ['unconfirmed', { outcome: 'unknown', reason: 'launch_outcome_unknown' }]
  ] as const)('maps a %s launch prompt to %o and links the pane', async (prompt, initial) => {
    const { seam, meta } = harness()
    const { launcher } = fakeLauncher(async () => launchResult(prompt))
    const started = await seam.start(
      { launcher, terminal: fakeTerminal().terminal },
      KEY,
      'd1',
      START
    )
    expect(started).toEqual({ conversation: KEY, initial })
    expect(meta[WORKTREE].externalConversations).toEqual([
      expect.objectContaining({
        source: 'dev',
        externalId: 'thread-1',
        paneKey: PANE,
        agent: 'claude'
      })
    ])
  })

  it('answers a launch that fails after publishing as linked but unknown', async () => {
    const { seam, meta } = harness()
    const { launcher } = fakeLauncher(async () => {
      throw new Error('prompt delivery crashed')
    })
    const started = await seam.start(
      { launcher, terminal: fakeTerminal().terminal },
      KEY,
      'd1',
      START
    )
    expect(started.initial).toEqual({ outcome: 'unknown', reason: 'launch_outcome_unknown' })
    expect(meta[WORKTREE].externalConversations).toHaveLength(1)
  })

  it('throws a launch that fails before publishing and links nothing', async () => {
    const { seam, meta } = harness()
    const { launcher } = fakeLauncher(
      async () => {
        throw new Error('selector_not_found')
      },
      undefined,
      false
    )
    await expect(
      seam.start({ launcher, terminal: fakeTerminal().terminal }, KEY, 'd1', START)
    ).rejects.toThrow('selector_not_found')
    expect(meta[WORKTREE]).toBeUndefined()
  })

  it('shares one creation between concurrent distinct starts and sends the second prompt', async () => {
    const { seam } = harness()
    const launched = deferred<void>()
    const { launcher, launch } = fakeLauncher(async () => {
      await launched.promise
      return launchResult('handed-to-terminal')
    })
    const terminal = fakeTerminal()
    const host = { launcher, terminal: terminal.terminal }
    const first = seam.start(host, KEY, 'd1', START)
    const second = seam.start(host, KEY, 'd2', { ...START, prompt: 'second' })
    launched.resolve()
    expect((await first).initial).toEqual({ outcome: 'accepted' })
    expect((await second).initial).toEqual({ outcome: 'accepted' })
    expect(launch).toHaveBeenCalledTimes(1)
    expect(terminal.writes).toEqual(['second'])
  })

  it('answers a start rebuilt from a link alone as unknown, without launching', async () => {
    const { seam, store } = harness()
    store.setWorktreeMeta(hostWorktreeTarget({ id: WORKTREE, hostId: 'local' }), {
      externalConversations: [{ ...KEY, paneKey: PANE, agent: 'claude', createdAt: 1 }]
    })
    const { launcher, launch } = fakeLauncher(async () => launchResult('handed-to-terminal'))
    const started = await seam.start(
      { launcher, terminal: fakeTerminal().terminal },
      KEY,
      'd1',
      START
    )
    expect(started.initial).toEqual({ outcome: 'unknown', reason: 'launch_outcome_unknown' })
    expect(launch).not.toHaveBeenCalled()
  })

  it('links a created folder workspace on its folder record', async () => {
    const { seam, folders } = harness()
    folders.push({ id: 'f-1' })
    const { launcher } = fakeLauncher(
      async () => launchResult('handed-to-terminal', 'folder:f-1'),
      {
        worktreeId: 'folder:f-1',
        sshHostId: null
      }
    )
    await seam.start({ launcher, terminal: fakeTerminal().terminal }, KEY, 'd1', {
      ...START,
      target: { kind: 'create-folder-workspace', create: { projectGroupId: 'g-1' } }
    })
    expect(folders[0].externalConversations).toEqual([expect.objectContaining({ paneKey: PANE })])
  })

  it('writes an SSH workspace link to that host’s row', async () => {
    const { seam, writes } = harness()
    const { launcher } = fakeLauncher(async () => launchResult('handed-to-terminal'), {
      worktreeId: WORKTREE,
      sshHostId: 'ssh:box'
    })
    await seam.start({ launcher, terminal: fakeTerminal().terminal }, KEY, 'd1', START)
    expect(writes).toEqual([{ id: WORKTREE, hostId: 'ssh:box' }])
  })

  it.each([
    ['an agent off the list', 'opencode', {}],
    ['an agent without status hooks', 'claude', { agentStatusHooksEnabled: false }]
  ] as const)('refuses %s', async (_label, agent, settings) => {
    const { seam } = harness(settings)
    const { launcher, launch } = fakeLauncher(async () => launchResult('handed-to-terminal'))
    const started = await seam.start({ launcher, terminal: fakeTerminal().terminal }, KEY, 'd1', {
      ...START,
      agent
    })
    expect(started.initial).toEqual({ outcome: 'refused', reason: 'unsupported_agent' })
    expect(launch).not.toHaveBeenCalled()
  })
})

describe('ExternalConversationSeam delivery ids', () => {
  it('shares one delivery for a repeated id and payload, and refuses another payload', async () => {
    const { seam } = harness()
    const { launcher, launch } = fakeLauncher(async () => launchResult('handed-to-terminal'))
    const host = { launcher, terminal: fakeTerminal().terminal }
    const first = seam.start(host, KEY, 'd1', START)
    const replay = seam.start(host, KEY, 'd1', START)
    expect((await first).initial).toEqual((await replay).initial)
    expect(launch).toHaveBeenCalledTimes(1)
    expect(await seam.send(host, KEY, 'd1', 'other')).toEqual({
      outcome: 'refused',
      reason: 'delivery_id_reused'
    })
  })

  it('scopes delivery ids by conversation', async () => {
    const { seam } = harness()
    const { launcher, launch } = fakeLauncher(async () => launchResult('handed-to-terminal'))
    const host = { launcher, terminal: fakeTerminal().terminal }
    await seam.start(host, KEY, 'd1', START)
    await seam.start(host, { ...KEY, externalId: 'thread-2' }, 'd1', START)
    expect(launch).toHaveBeenCalledTimes(2)
  })
})

async function started() {
  const h = harness()
  const terminal = fakeTerminal()
  const { launcher } = fakeLauncher(async () => launchResult('handed-to-terminal'))
  const host = { launcher, terminal: terminal.terminal }
  await h.seam.start(host, KEY, 'start', START)
  return { ...h, terminal, host }
}

describe('ExternalConversationSeam send', () => {
  it('pastes a follow-up and answers accepted', async () => {
    const { seam, host, terminal } = await started()
    expect(await seam.send(host, KEY, 'd1', 'hello')).toEqual({ outcome: 'accepted' })
    expect(terminal.writes).toEqual(['hello'])
    expect(terminal.sendTerminalAgentPrompt).toHaveBeenCalledWith(
      'term-1',
      'hello',
      expect.objectContaining({ inputKind: 'driving', acceptQueued: true })
    )
  })

  it.each([
    ['before', false],
    ['after', true]
  ])('answers a writer that throws %s the paste as writer_failed', async (_when, pasted) => {
    const { seam, host, terminal } = await started()
    terminal.sendTerminalAgentPrompt.mockImplementationOnce(async (_handle, prompt, options) => {
      if (pasted) {
        await options.beforeWrite?.('pty-1')
        terminal.writes.push(prompt)
      }
      throw new Error('agent_prompt_blocked')
    })
    expect(await seam.send(host, KEY, 'd1', 'hello')).toEqual({
      outcome: 'unknown',
      reason: 'writer_failed'
    })
  })

  it('refuses a conversation whose agent pane is gone', async () => {
    const { seam, host, terminal } = await started()
    terminal.exit()
    expect(await seam.send(host, KEY, 'd1', 'hello')).toEqual({
      outcome: 'refused',
      reason: 'agent_not_reachable'
    })
  })

  it('throws for a conversation it never started', async () => {
    const { seam, host } = await started()
    await expect(seam.send(host, { ...KEY, externalId: 'nope' }, 'd1', 'x')).rejects.toThrow(
      'external_conversation_not_found'
    )
  })

  it('clears a stale line before the next paste, and skips that on a new binding', async () => {
    const { seam, host, terminal } = await started()
    terminal.sendTerminalAgentPrompt.mockRejectedValueOnce(new Error('terminal_not_writable'))
    expect((await seam.send(host, KEY, 'd1', 'lost')).outcome).toBe('unknown')
    expect(await seam.send(host, KEY, 'd2', 'next')).toEqual({ outcome: 'accepted' })
    expect(terminal.sendTerminal).toHaveBeenCalledTimes(1)
    expect(terminal.writes[0]).toBe(buildAgentTuiClearInputForText('lost'))
    expect(terminal.writes[1]).toBe('next')

    terminal.sendTerminalAgentPrompt.mockRejectedValueOnce(new Error('terminal_not_writable'))
    await seam.send(host, KEY, 'd3', 'lost again')
    terminal.state.ptyId = 'pty-2'
    expect(await seam.send(host, KEY, 'd4', 'fresh')).toEqual({ outcome: 'accepted' })
    expect(terminal.sendTerminal).toHaveBeenCalledTimes(1)
  })

  it('carries a refused clear as the follow-up answer and pastes nothing', async () => {
    const { seam, host, terminal } = await started()
    terminal.sendTerminalAgentPrompt.mockRejectedValueOnce(new Error('terminal_not_writable'))
    await seam.send(host, KEY, 'd1', 'lost')
    const write = writeRefused('endpoint_disconnected')
    terminal.sendTerminal.mockResolvedValueOnce({
      handle: 'term-1',
      accepted: false,
      bytesWritten: 0,
      writeSettlement: write
    })
    expect(await seam.send(host, KEY, 'd2', 'next')).toEqual({
      outcome: 'refused',
      reason: 'write_refused',
      write
    })
    expect(terminal.writes).toEqual([])
  })
})

describe('ExternalConversationSeam hold', () => {
  it('holds while the agent asks, even with no hook row, and sends on the recheck', async () => {
    vi.useFakeTimers()
    const { seam, host, terminal } = await started()
    terminal.state.blocked = true
    const sent = seam.send(host, KEY, 'd1', 'held')
    await vi.advanceTimersByTimeAsync(3000)
    expect(terminal.writes).toEqual([])
    terminal.state.blocked = false
    await vi.advanceTimersByTimeAsync(1000)
    expect(await sent).toEqual({ outcome: 'accepted' })
  })

  it('catches an answer that lands while it subscribes', async () => {
    const { seam, host, terminal } = await started()
    terminal.state.blocked = true
    const subscribe = terminal.terminal.agentTransitions.subscribe
    terminal.terminal.agentTransitions.subscribe = (listener) => {
      terminal.state.blocked = false
      return subscribe(listener)
    }
    expect(await seam.send(host, KEY, 'd1', 'held')).toEqual({ outcome: 'accepted' })
  })

  it.each(['allowed', 'denied'])('releases when the approval is %s', async () => {
    const { seam, host, terminal } = await started()
    terminal.state.blocked = true
    const sent = seam.send(host, KEY, 'd1', 'held')
    await Promise.resolve()
    terminal.state.blocked = false
    terminal.observe()
    expect(await sent).toEqual({ outcome: 'accepted' })
    expect(terminal.transitionListeners.size).toBe(0)
  })

  it('settles the held head and everything behind it when the agent exits', async () => {
    const { seam, host, terminal } = await started()
    terminal.state.blocked = true
    const head = seam.send(host, KEY, 'd1', 'one')
    const follower = seam.send(host, KEY, 'd2', 'two')
    await vi.waitFor(() => expect(terminal.transitionListeners.size).toBe(1))
    terminal.state.ptyId = 'pty-2'
    terminal.exit()
    const unreachable = { outcome: 'refused', reason: 'agent_not_reachable' }
    expect(await head).toEqual(unreachable)
    expect(await follower).toEqual(unreachable)
    expect(terminal.writes).toEqual([])
  })

  it('settles a held send when connectors are turned off', async () => {
    const { seam, host, terminal, releaseInvalidations } = await started()
    terminal.state.blocked = true
    const sent = seam.send(host, KEY, 'd1', 'held')
    await vi.waitFor(() => expect(terminal.transitionListeners.size).toBe(1))
    seam.dispose('connectors_disabled')
    expect(await sent).toEqual({ outcome: 'refused', reason: 'connectors_disabled' })
    expect(terminal.transitionListeners.size).toBe(0)
    expect(releaseInvalidations).toHaveBeenCalledTimes(1)
  })

  it('writes nothing when turned off between the hold and the paste', async () => {
    const { seam, host, terminal } = await started()
    const foreground = deferred<'agent'>()
    terminal.terminal.readLaunchedAgentForeground.mockReturnValueOnce(foreground.promise)
    const sent = seam.send(host, KEY, 'd1', 'late')
    await vi.waitFor(() => expect(terminal.terminal.readLaunchedAgentForeground).toHaveBeenCalled())
    seam.dispose('connectors_disabled')
    foreground.resolve('agent')
    expect(await sent).toEqual({ outcome: 'refused', reason: 'connectors_disabled' })
    expect(terminal.writes).toEqual([])
  })
})

describe('ExternalConversationSeam index', () => {
  it('stops answering for a removed workspace, and follows a renamed one', async () => {
    const { seam, host, meta } = await started()
    const links = meta[WORKTREE].externalConversations
    delete meta[WORKTREE]
    await expect(seam.send(host, KEY, 'd1', 'x')).rejects.toThrow('external_conversation_not_found')
    meta['repo-1::/work/renamed'] = { externalConversations: links }
    expect(await seam.send(host, KEY, 'd2', 'y')).toEqual({ outcome: 'accepted' })
  })
})
