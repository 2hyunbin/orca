import { describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { hostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'
import { ExternalConversationSeam } from './external-conversation-seam'
import type { ConversationKey } from './external-conversation-types'
import {
  fakeLauncher,
  fakeLinkStore,
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

describe('ExternalConversationSeam start', () => {
  it.each([
    ['handed-to-terminal', { outcome: 'accepted' }],
    ['not-delivered', { outcome: 'unknown', reason: 'launch_outcome_unknown' }],
    ['unconfirmed', { outcome: 'unknown', reason: 'launch_outcome_unknown' }]
  ] as const)('maps a %s launch prompt to %o and links the pane', async (prompt, initial) => {
    const { seam, meta } = harness()
    const { launcher } = fakeLauncher(async () => launchResult(prompt))
    const started = await seam.start({ launcher }, KEY, 'd1', START)
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
    const started = await seam.start({ launcher }, KEY, 'd1', START)
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
    await expect(seam.start({ launcher }, KEY, 'd1', START)).rejects.toThrow('selector_not_found')
    expect(meta[WORKTREE]).toBeUndefined()
  })

  it('shares one creation between concurrent distinct starts', async () => {
    const { seam } = harness()
    const launched = deferred<void>()
    const { launcher, launch } = fakeLauncher(async () => {
      await launched.promise
      return launchResult('handed-to-terminal')
    })
    const first = seam.start({ launcher }, KEY, 'd1', START)
    const second = seam.start({ launcher }, KEY, 'd2', { ...START, prompt: 'second' })
    launched.resolve()
    expect((await first).initial).toEqual({ outcome: 'accepted' })
    expect((await second).initial).toEqual({ outcome: 'unknown', reason: 'launch_outcome_unknown' })
    expect(launch).toHaveBeenCalledTimes(1)
  })

  it('answers a start rebuilt from a link alone as unknown, without launching', async () => {
    const { seam, store } = harness()
    store.setWorktreeMeta(hostWorktreeTarget({ id: WORKTREE, hostId: 'local' }), {
      externalConversations: [{ ...KEY, paneKey: PANE, agent: 'claude', createdAt: 1 }]
    })
    const { launcher, launch } = fakeLauncher(async () => launchResult('handed-to-terminal'))
    const started = await seam.start({ launcher }, KEY, 'd1', START)
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
    await seam.start({ launcher }, KEY, 'd1', {
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
    await seam.start({ launcher }, KEY, 'd1', START)
    expect(writes).toEqual([{ id: WORKTREE, hostId: 'ssh:box' }])
  })

  it.each([
    ['an agent off the list', 'opencode', {}],
    ['an agent without status hooks', 'claude', { agentStatusHooksEnabled: false }]
  ] as const)('refuses %s', async (_label, agent, settings) => {
    const { seam } = harness(settings)
    const { launcher, launch } = fakeLauncher(async () => launchResult('handed-to-terminal'))
    const started = await seam.start({ launcher }, KEY, 'd1', {
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
    const host = { launcher }
    const first = seam.start(host, KEY, 'd1', START)
    const replay = seam.start(host, KEY, 'd1', START)
    expect((await first).initial).toEqual((await replay).initial)
    expect(launch).toHaveBeenCalledTimes(1)
    expect((await seam.start(host, KEY, 'd1', { ...START, prompt: 'other' })).initial).toEqual({
      outcome: 'refused',
      reason: 'delivery_id_reused'
    })
  })

  it('scopes delivery ids by conversation', async () => {
    const { seam } = harness()
    const { launcher, launch } = fakeLauncher(async () => launchResult('handed-to-terminal'))
    const host = { launcher }
    await seam.start(host, KEY, 'd1', START)
    await seam.start(host, { ...KEY, externalId: 'thread-2' }, 'd1', START)
    expect(launch).toHaveBeenCalledTimes(2)
  })
})

describe('ExternalConversationSeam index', () => {
  it('forgets a removed workspace, and follows a renamed one', async () => {
    const { seam, meta } = harness()
    const { launcher, launch } = fakeLauncher(async () => launchResult('handed-to-terminal'))
    await seam.start({ launcher }, KEY, 'd1', START)
    const links = meta[WORKTREE].externalConversations
    meta['repo-1::/work/renamed'] = { externalConversations: links }
    delete meta[WORKTREE]
    expect((await seam.start({ launcher }, KEY, 'd2', START)).initial).toEqual({
      outcome: 'unknown',
      reason: 'launch_outcome_unknown'
    })
    delete meta['repo-1::/work/renamed']
    await seam.start({ launcher }, KEY, 'd3', START)
    expect(launch).toHaveBeenCalledTimes(2)
  })
})
