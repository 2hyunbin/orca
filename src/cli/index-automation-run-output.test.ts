import { describe, expect, it, vi } from 'vitest'
import type { AutomationRun } from '../shared/automations-types'

const {
  callMock,
  runtimeClientConstructorMock,
  serveOrcaAppMock,
  getDefaultUserDataPathMock,
  addEnvironmentFromPairingCodeMock,
  listEnvironmentsMock,
  spawnMock
} = vi.hoisted(() => ({
  callMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn(),
  serveOrcaAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/tmp/orca-user-data'),
  addEnvironmentFromPairingCodeMock: vi.fn(),
  listEnvironmentsMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('./runtime-client', async () => {
  const { createRuntimeClientModuleMock } = await import('./index-test-harness.js')
  return createRuntimeClientModuleMock({
    callMock,
    runtimeClientConstructorMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock
  })
})

vi.mock('./runtime/environments', () => ({
  addEnvironmentFromPairingCode: addEnvironmentFromPairingCodeMock,
  listEnvironments: listEnvironmentsMock,
  removeEnvironment: vi.fn(),
  resolveEnvironment: vi.fn()
}))

vi.mock('child_process', async () => {
  const { createChildProcessModuleMock } = await import('./index-test-harness.js')
  return createChildProcessModuleMock(spawnMock)
})

import { main } from './index'
import { okFixture, queueFixtures } from './test-fixtures'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'

const AUTOMATION_ID = '497bafa9-5a97-4f85-9e48-2b211b8f31fa'
const RUN_ID = 'd99b909f-c4a1-4b56-9979-abf57e94be11'

function run(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: RUN_ID,
    automationId: AUTOMATION_ID,
    title: 'Daily checks run 1',
    status: 'dispatching',
    trigger: 'manual',
    scheduledFor: 0,
    workspaceId: null,
    sessionKind: 'terminal',
    chatSessionId: null,
    terminalSessionId: null,
    terminalPaneKey: null,
    terminalPtyId: null,
    outputSnapshot: null,
    precheckResult: null,
    usage: null,
    error: null,
    startedAt: null,
    dispatchedAt: null,
    createdAt: 0,
    ...overrides
  }
}

function queueRun(result: AutomationRun): void {
  queueFixtures(
    callMock,
    okFixture('req_owner', { automation: { id: AUTOMATION_ID } }),
    okFixture('req_run', { run: result })
  )
}

describe('automation run command output', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it.each([
    { status: 'pending', acknowledgement: `Queued run ${RUN_ID} (pending).` },
    {
      status: 'dispatching',
      acknowledgement: `Accepted run ${RUN_ID}; launch is still in progress (dispatching).`
    },
    { status: 'dispatched', acknowledgement: `Started run ${RUN_ID} (dispatched).` },
    { status: 'completed', acknowledgement: `Completed run ${RUN_ID}.` },
    { status: 'dispatch_failed', acknowledgement: `Run ${RUN_ID} failed (dispatch_failed).` },
    {
      status: 'skipped_unavailable',
      acknowledgement: `Skipped run ${RUN_ID} (skipped_unavailable).`
    },
    {
      status: 'skipped_precheck',
      acknowledgement: `Skipped run ${RUN_ID} (skipped_precheck).`
    },
    {
      status: 'skipped_missed',
      acknowledgement: `Skipped run ${RUN_ID} (skipped_missed).`
    },
    {
      status: 'skipped_needs_interactive_auth',
      acknowledgement: `Skipped run ${RUN_ID} (skipped_needs_interactive_auth).`
    }
  ] as const)(
    'prints the authoritative $status outcome without unknown handles',
    async ({ status, acknowledgement }) => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      const error = status === 'dispatch_failed' ? 'Agent launch failed.' : null
      queueRun(run({ status, error }))
      await main(['automations', 'run', AUTOMATION_ID], '/tmp/repo')
      expect(log).toHaveBeenCalledExactlyOnceWith(
        [
          acknowledgement,
          `id: ${RUN_ID}`,
          `automationId: ${AUTOMATION_ID}`,
          'title: Daily checks run 1',
          `status: ${status}`,
          'trigger: manual',
          'scheduledFor: 1970-01-01T00:00:00.000Z',
          ...(error ? [`error: ${error}`] : []),
          `Follow up: orca automations runs --id ${AUTOMATION_ID}`
        ].join('\n')
      )
      expect(callMock).toHaveBeenCalledTimes(2)
      expect(callMock).toHaveBeenNthCalledWith(2, 'automation.runNow', { id: AUTOMATION_ID })
    }
  )

  it('prints workspace and terminal identities only when supplied by the host', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    queueRun(
      run({
        status: 'dispatched',
        workspaceId: 'folder:workspace-1',
        terminalSessionId: 'tab-1',
        terminalPaneKey: 'tab-1:leaf-1',
        terminalPtyId: 'pty-1'
      })
    )
    await main(['automations', 'run', AUTOMATION_ID], '/tmp/repo')
    expect(log).toHaveBeenCalledExactlyOnceWith(
      [
        `Started run ${RUN_ID} (dispatched).`,
        `id: ${RUN_ID}`,
        `automationId: ${AUTOMATION_ID}`,
        'title: Daily checks run 1',
        'status: dispatched',
        'trigger: manual',
        'scheduledFor: 1970-01-01T00:00:00.000Z',
        'workspaceId: folder:workspace-1',
        'terminalSessionId: tab-1',
        'terminalPaneKey: tab-1:leaf-1',
        'terminalPtyId: pty-1',
        `Follow up: orca automations runs --id ${AUTOMATION_ID}`
      ].join('\n')
    )
  })

  it('preserves the supplied precheck and error on a skipped run', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    queueRun(
      run({
        status: 'skipped_precheck',
        error: 'Precheck exited with code 1.',
        precheckResult: {
          command: 'test -f ready',
          exitCode: 1,
          timedOut: false,
          durationMs: 1,
          stdout: '',
          stderr: 'Not ready',
          stdoutTruncated: false,
          stderrTruncated: false,
          error: null,
          startedAt: 0,
          completedAt: 1
        }
      })
    )
    await main(['automations', 'run', AUTOMATION_ID], '/tmp/repo')
    expect(log).toHaveBeenCalledExactlyOnceWith(
      [
        `Skipped run ${RUN_ID} (skipped_precheck).`,
        `id: ${RUN_ID}`,
        `automationId: ${AUTOMATION_ID}`,
        'title: Daily checks run 1',
        'status: skipped_precheck',
        'trigger: manual',
        'scheduledFor: 1970-01-01T00:00:00.000Z',
        'precheck: exit 1; Not ready',
        'error: Precheck exited with code 1.',
        `Follow up: orca automations runs --id ${AUTOMATION_ID}`
      ].join('\n')
    )
  })

  it.each([
    'pending',
    'dispatching',
    'dispatched',
    'dispatch_failed',
    'skipped_unavailable'
  ] as const)('adds a JSON runId while retaining the %s run and RPC metadata', async (status) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const result = run({ status })
    queueRun(result)
    await main(['automations', 'run', AUTOMATION_ID, '--json'], '/tmp/repo')
    const output = String(log.mock.calls[0]?.[0])
    expect(JSON.parse(output)).toEqual(okFixture('req_run', { run: result, runId: RUN_ID }))
  })

  it('prints no acknowledgment until the host returns a delayed result', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    queueFixtures(callMock, okFixture('req_owner', { automation: { id: AUTOMATION_ID } }))
    let respond: (value: ReturnType<typeof okFixture>) => void = () => {}
    callMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          respond = resolve
        })
    )
    const command = main(['automations', 'run', AUTOMATION_ID], '/tmp/repo')
    await vi.waitFor(() => expect(callMock).toHaveBeenCalledTimes(2))
    expect(log).not.toHaveBeenCalled()
    respond(okFixture('req_run', { run: run({ status: 'dispatched' }) }))
    await command
    expect(log).toHaveBeenCalledTimes(1)
    expect(String(log.mock.calls[0]?.[0]).split('\n')[0]).toBe(
      `Started run ${RUN_ID} (dispatched).`
    )
  })

  it('supports old host responses that omit terminal identity fields', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { terminalPaneKey: _pane, terminalPtyId: _pty, ...legacyRun } = run()
    queueFixtures(
      callMock,
      okFixture('req_owner', { automation: { id: AUTOMATION_ID } }),
      okFixture('req_run', { run: legacyRun })
    )
    await main(['automations', 'run', AUTOMATION_ID, '--json'], '/tmp/repo')
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual(
      okFixture('req_run', { run: legacyRun, runId: RUN_ID })
    )
  })

  it('prints an unfamiliar newer-host status without claiming the run started', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    queueFixtures(
      callMock,
      okFixture('req_owner', { automation: { id: AUTOMATION_ID } }),
      okFixture('req_run', { run: { ...run(), status: 'future_status' } })
    )
    await main(['automations', 'run', AUTOMATION_ID], '/tmp/repo')
    expect(String(log.mock.calls[0]?.[0]).split('\n')[0]).toBe(`Run ${RUN_ID}: future_status.`)
  })

  it('preserves the SSH owner fence while adding the runId', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const owner = { selector: { kind: 'ssh', targetId: 'ssh-1', targetGeneration: 3 } }
    queueFixtures(
      callMock,
      okFixture('req_owner', { automation: { id: AUTOMATION_ID }, owner }),
      okFixture('req_run', { run: run() })
    )
    await main(['automations', 'run', AUTOMATION_ID, '--json'], '/tmp/repo')
    expect(callMock).toHaveBeenNthCalledWith(2, 'automation.runNow', {
      id: AUTOMATION_ID,
      expectedOwner: owner
    })
    expect(JSON.parse(String(log.mock.calls[0]?.[0])).result.runId).toBe(RUN_ID)
  })

  it('explains full UUIDs and pending launch behavior in run help', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(['automations', 'run', '--help'], '/tmp/repo')
    expect(String(log.mock.calls[0]?.[0])).toContain(
      'Use the full automation UUID from orca automations list; shortened prefixes are not accepted.'
    )
    expect(String(log.mock.calls[0]?.[0])).toContain(
      'A queued or dispatching run has been accepted'
    )
    expect(String(log.mock.calls[0]?.[0])).toContain(`orca automations run ${AUTOMATION_ID}`)
    expect(callMock).not.toHaveBeenCalled()
  })
})
