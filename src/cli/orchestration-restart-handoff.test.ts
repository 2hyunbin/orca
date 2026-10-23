import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'

const entity = z.object({ id: z.string() })
const check = z.object({
  result: z.object({
    runId: z.string(),
    deliveryId: z.string(),
    messages: z.array(z.object({ id: z.string() }).passthrough())
  })
})

function idOf(response: unknown, key: string): string {
  const { result } = z.object({ result: z.record(z.string(), z.unknown()) }).parse(response)
  return entity.parse(result[key]).id
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

it('retains CLI work and mail across restart, refuses takeover, and completes a separate Run handoff', async () => {
  const home = mkdtempSync(join(tmpdir(), 'orca-cli-restart-handoff-'))
  for (const name of [
    'HOME',
    'USERPROFILE',
    'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME',
    'XDG_RUNTIME_DIR',
    'CLAUDE_CONFIG_DIR',
    'CODEX_HOME',
    'ORCA_E2E_HOME_DIR',
    'ORCA_E2E_USER_DATA_DIR',
    'ORCA_USER_DATA_PATH'
  ]) {
    vi.stubEnv(name, home)
  }
  vi.stubEnv('ORCA_BACKGROUND_LAUNCH', '1')
  vi.stubEnv('ORCA_DISABLE_MACOS_LOGIN_SHELL', '1')
  for (const name of [
    'ORCA_ENVIRONMENT',
    'ORCA_PAIRING_CODE',
    'ORCA_REMOTE_PAIRING',
    'ORCA_AGENT_SESSION_ID',
    'ORCA_RUNTIME_SOURCE_ID',
    'ORCA_RUNTIME_SOURCE_INCARNATION',
    'ORCA_RUNTIME_SOURCE_PROFILE_PATH'
  ]) {
    vi.stubEnv(name, '')
  }
  const { main } = await import('./index')
  const { OrchestrationDb } = await import('../main/runtime/orchestration/db')
  const { OrcaRuntimeRpcServer } = await import('../main/runtime/runtime-rpc')
  const fixture = await import('../main/runtime/orchestration-mailbox-notification-test-harness')
  const { registerBoundPty } = await import('../main/runtime/bind-first-pane.test-fixture')
  const coord = fixture.TERMINAL_HANDLE
  const worker = fixture.SECOND_TERMINAL_HANDLE
  const predecessor = 'term_predecessor'
  const predecessorTab = '55555555-5555-4555-8555-555555555555'
  const predecessorLeaf = '66666666-6666-4666-8666-666666666666'
  const predecessorPane = `${predecessorTab}:${predecessorLeaf}`
  let predecessorPresence: 'live' | 'exited' = 'live'
  let db = new OrchestrationDb(join(home, 'orchestration.db'))

  function runtimeForDatabase() {
    const { runtime } = fixture.createRuntime(db, {
      checkHookAgentPresence: async (pane) =>
        pane === predecessorPane ? predecessorPresence : 'live'
    })
    fixture.registerSecondPane(runtime)
    registerBoundPty(runtime, 'pty-predecessor', fixture.WORKTREE_ID, null, {
      tabId: predecessorTab,
      leafId: predecessorLeaf,
      incarnationId: 'predecessor-incarnation'
    })
    runtime.registerPreAllocatedHandleForPty('pty-predecessor', predecessor)
    vi.spyOn(runtime, 'getNestedWorkerMaxDepth').mockReturnValue(2)
    return runtime
  }
  let runtime = runtimeForDatabase()
  let server = new OrcaRuntimeRpcServer({ runtime, userDataPath: home })
  const output = vi.spyOn(console, 'log').mockImplementation(() => {})
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  const originalExitCode = process.exitCode

  async function cli(handle: string, args: string[], exitCode = 0): Promise<unknown> {
    vi.stubEnv('ORCA_TERMINAL_HANDLE', handle)
    vi.stubEnv('ORCA_PANE_KEY', runtime.getTerminalPaneKey(handle) ?? '')
    vi.stubEnv(
      'ORCA_AGENT_LAUNCH_TOKEN',
      handle === coord ? fixture.LAUNCH_TOKEN : handle === worker ? fixture.SECOND_LAUNCH_TOKEN : ''
    )
    output.mockClear()
    stderr.mockClear()
    process.exitCode = 0
    await main(['orchestration', ...args, '--json'], home)
    expect(
      process.exitCode,
      JSON.stringify({ args, output: output.mock.calls, stderr: stderr.mock.calls })
    ).toBe(exitCode)
    expect(output.mock.calls).toHaveLength(1)
    const response: unknown = JSON.parse(String(output.mock.calls.at(-1)?.[0]))
    expect(response).toMatchObject({ ok: exitCode === 0 })
    return response
  }

  try {
    await server.start()
    const root = idOf(
      await cli(coord, ['run-create', '--objective', 'Retained parent work']),
      'run'
    )
    const task = idOf(await cli(coord, ['task-create', '--spec', 'Finish after restart']), 'task')
    const dispatch = idOf(
      await cli(coord, ['dispatch', '--task', task, '--to', worker]),
      'dispatch'
    )
    const separate = idOf(
      await cli(predecessor, ['run-create', '--objective', 'Predecessor work']),
      'run'
    )
    const continuation = idOf(
      await cli(predecessor, ['task-create', '--spec', 'Continue predecessor work']),
      'task'
    )
    const retainedMessage = idOf(
      await cli(worker, ['send', '--subject', 'Retain this report']),
      'message'
    )
    const retainedBatch = check.parse(await cli(coord, ['check'])).result
    expect(retainedBatch).toMatchObject({ runId: root, messages: [{ id: retainedMessage }] })

    await server.stop()
    db.close()
    db = new OrchestrationDb(join(home, 'orchestration.db'))
    runtime = runtimeForDatabase()
    server = new OrcaRuntimeRpcServer({ runtime, userDataPath: home })
    await server.start()
    expect(await cli(coord, ['run-current'])).toMatchObject({ result: { run: { id: root } } })
    expect(await cli(coord, ['task-list'])).toMatchObject({
      result: { tasks: [{ id: task, status: 'dispatched', dispatch_id: dispatch }] }
    })
    expect(check.parse(await cli(coord, ['check'])).result).toEqual(retainedBatch)

    const bindingBefore = db.getRunRaw(root)
    expect(await cli(worker, ['run-use', '--id', root], 1)).toMatchObject({
      error: { code: 'worker_cannot_coordinate_own_run', data: { effectsApplied: false } }
    })
    expect(db.getRunRaw(root)).toEqual(bindingBefore)
    expect(check.parse(await cli(coord, ['check'])).result).toEqual(retainedBatch)
    expect(await cli(coord, ['check', '--ack', retainedBatch.deliveryId])).toMatchObject({
      result: { acknowledged: retainedBatch.deliveryId, count: 0 }
    })
    expect(await cli(worker, ['run-use', '--id', separate], 1)).toMatchObject({
      error: { code: 'run_coordinator_live', data: { effectsApplied: false } }
    })
    predecessorPresence = 'exited'
    expect(await cli(worker, ['run-use', '--id', separate])).toMatchObject({
      result: { run: { id: separate } }
    })

    const question = idOf(
      await cli(worker, [
        'send',
        '--to',
        `run:${root}`,
        '--type',
        'question',
        '--subject',
        'Proceed with predecessor work?'
      ]),
      'message'
    )
    const questionBatch = check.parse(await cli(coord, ['check'])).result
    expect(questionBatch).toMatchObject({
      runId: root,
      messages: [{ id: question, type: 'question' }]
    })
    const reply = idOf(
      await cli(coord, ['reply', '--id', question, '--body', 'Proceed with the retained task']),
      'message'
    )
    const replyBatch = check.parse(await cli(worker, ['check'])).result
    expect(replyBatch).toMatchObject({
      runId: separate,
      messages: [
        {
          id: reply,
          thread_id: question,
          to_handle: `run:${separate}`,
          run_id: separate,
          body: 'Proceed with the retained task'
        }
      ]
    })
    expect(db.getMessageById(reply)?.read).toBe(0)
    expect(await cli(worker, ['check', '--ack', replyBatch.deliveryId])).toMatchObject({
      result: { runId: separate, acknowledged: replyBatch.deliveryId, count: 0 }
    })
    expect(db.getMessageById(reply)?.read).toBe(1)
    await cli(coord, ['check', '--ack', questionBatch.deliveryId])

    const continuedDispatch = idOf(
      await cli(worker, ['dispatch', '--task', continuation, '--to', predecessor]),
      'dispatch'
    )
    expect(
      await cli(predecessor, [
        'send',
        '--type',
        'worker_done',
        '--subject',
        'Predecessor work complete',
        '--payload',
        JSON.stringify({
          taskId: continuation,
          dispatchId: continuedDispatch,
          outcome: 'succeeded'
        })
      ])
    ).toMatchObject({ result: { lifecycle: { action: 'completed' } } })
    expect(await cli(worker, ['task-list'])).toMatchObject({
      result: { tasks: [{ id: continuation, status: 'completed' }] }
    })
    expect(await cli(worker, ['dispatch-show', '--task', continuation])).toMatchObject({
      result: { dispatch: { id: continuedDispatch, status: 'completed' } }
    })

    expect(
      await cli(worker, [
        'send',
        '--type',
        'worker_done',
        '--subject',
        'Parent work complete',
        '--payload',
        JSON.stringify({ taskId: task, dispatchId: dispatch, outcome: 'succeeded' })
      ])
    ).toMatchObject({ result: { lifecycle: { action: 'completed' } } })
    expect(await cli(coord, ['task-list'])).toMatchObject({
      result: { tasks: [{ id: task, status: 'completed' }] }
    })
    expect(await cli(coord, ['dispatch-show', '--task', task])).toMatchObject({
      result: { dispatch: { id: dispatch, status: 'completed' } }
    })
  } finally {
    process.exitCode = originalExitCode
    await server.stop()
    db.close()
    rmSync(home, { recursive: true, force: true })
  }
})
