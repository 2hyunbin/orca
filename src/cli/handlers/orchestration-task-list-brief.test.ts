import { describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

// Why: isolate the handler's flag-to-param mapping; printResult only writes output.
vi.mock('../format', () => ({ printResult: vi.fn() }))

import { ORCHESTRATION_HANDLERS } from './orchestration'
import { printResult } from '../format'
import { okFixture } from '../test-fixtures'

async function runTaskListBrief(): Promise<unknown> {
  vi.mocked(printResult).mockClear()
  await ORCHESTRATION_HANDLERS['orchestration task-list']({
    flags: new Map<string, string | boolean>([
      ['brief', true],
      ['run', 'run_1']
    ]),
    client: { call: callMock },
    json: true
  } as never)
  expect(callMock).toHaveBeenCalledOnce()
  expect(callMock).toHaveBeenCalledWith('orchestration.taskList', {
    status: undefined,
    ready: undefined,
    brief: true,
    run: 'run_1',
    callerTerminalHandle: undefined
  })
  expect(printResult).toHaveBeenCalledOnce()
  const printCall = vi.mocked(printResult).mock.calls[0]
  if (!printCall) {
    throw new Error('task-list did not print its response')
  }
  expect(printCall[1]).toBe(true)
  return printCall[0]
}

describe('orchestration task-list brief output', () => {
  it('requests server-side brief and falls back client-side for older runtimes', async () => {
    callMock.mockReset().mockResolvedValue(
      okFixture('req_tasks', {
        // No spec_truncated field — the pre-brief-runtime signature.
        tasks: [{ id: 'task_1', spec: `First line\n${'detail '.repeat(40)}`, status: 'ready' }],
        count: 1
      })
    )

    const response = await runTaskListBrief()

    expect(response).toHaveProperty('result.tasks.0.spec', `First line ${'detail '.repeat(21)}d…`)
    expect(response).toHaveProperty('result.tasks.0.spec_truncated', true)
  })

  it('passes server-abbreviated rows through untouched', async () => {
    const serverTasks = [
      { id: 'task_1', spec: 'already brief…', status: 'ready', spec_truncated: true }
    ]
    const serverResponse = okFixture('req_tasks', { tasks: serverTasks, count: 1 })
    callMock.mockReset().mockResolvedValue(serverResponse)

    const response = await runTaskListBrief()

    // Why: re-abbreviating a server-truncated spec would flip spec_truncated
    // back to false (the truncated text fits the cap).
    expect(response).toHaveProperty('result.tasks', serverTasks)
  })
})
