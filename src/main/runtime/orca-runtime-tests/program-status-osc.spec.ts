import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import type { RuntimeTerminalAgentStatusEvent } from '../orca-runtime-test-mocks.spec'
import {
  TEST_WORKTREE_PATH,
  expectStablePaneKeyEnv,
  spawnedPtyEnv,
  store
} from '../orca-runtime-test-fixtures.spec'

describe('OSC 7501 program status', () => {
  it('projects split reports from a rendererless PTY into hook-yielding status events', async () => {
    const statuses: RuntimeTerminalAgentStatusEvent[] = []
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-ps' })
    const runtime = new OrcaRuntimeService(store, undefined, {
      onTerminalAgentStatus: (event) => statuses.push(event)
    })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, { command: 'claude', title: 'w' })
    const paneKey = expectStablePaneKeyEnv(spawnedPtyEnv(spawn.mock.calls[0]?.[0]))

    const question = Buffer.from('answer: Tea or coffee?').toString('base64')
    runtime.onPtyData('pty-ps', 'x\x1b]7501;state=working:app=claude-code\x1b\\\x1b]75', 1)
    runtime.onPtyData(
      'pty-ps',
      `01;state=blocked:kind=question:app=claude-code:msg=${question}\x07`,
      2
    )

    expect(
      statuses.map((event) => [event.paneKey, event.fromProgramStatus, event.payload])
    ).toEqual([
      [paneKey, true, expect.objectContaining({ state: 'working', agentType: 'claude' })],
      [
        paneKey,
        true,
        expect.objectContaining({
          state: 'waiting',
          agentType: 'claude',
          toolInput: 'answer: Tea or coffee?'
        })
      ]
    ])
  })

  it("hands the store each chunk's facet before the rows that chunk publishes", async () => {
    const order: string[] = []
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-order' })
    const runtime = new OrcaRuntimeService(store, undefined, {
      onTerminalAgentStatus: (event) => order.push(`status:${event.payload.state}`),
      onTerminalProgramStatusFacet: (event) => order.push(`facet:${event.facet?.state ?? 'none'}`)
    })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, { command: 'brew', title: 'w' })

    runtime.onPtyData('pty-order', '\x1b]7501;state=working:app=brew:progress=10\x1b\\', 1)
    runtime.onPtyData('pty-order', '\x1b]7501;state=done:app=brew\x1b\\', 2)

    // Why it matters: a reader between the two (the 133;D drop) must never see done + a live facet.
    expect(order).toEqual(['facet:working', 'status:working', 'facet:done', 'status:done'])
  })

  it('clears a live facet when its PTY exits but keeps a finished one', async () => {
    const facets: [string, string | null][] = []
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-live' })
      .mockResolvedValueOnce({ id: 'pty-done' })
    const runtime = new OrcaRuntimeService(store, undefined, {
      onTerminalProgramStatusFacet: (event) =>
        facets.push([event.ptyId, event.facet?.state ?? null])
    })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, { command: 'brew', title: 'a' })
    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, { command: 'brew', title: 'b' })

    runtime.onPtyData('pty-live', '\x1b]7501;state=working:app=brew:progress=10\x1b\\', 1)
    runtime.onPtyData('pty-done', '\x1b]7501;state=done:app=brew\x1b\\', 1)
    await runtime.onPtyExit('pty-live', 0)
    await runtime.onPtyExit('pty-done', 0)

    expect(facets).toEqual([
      ['pty-live', 'working'],
      ['pty-done', 'done'],
      ['pty-live', null]
    ])
  })
})
