import { describe, expect, it, vi } from 'vitest'

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
import { buildWorktree, okFixture, queueFixtures, worktreeListFixture } from './test-fixtures'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'
import { agentLaunchFixture, agentLaunchHostFixture } from './agent-launch-test-fixtures'

const WORKTREE_ID = 'repo-1::/tmp/repo'

async function runRefused(argv: string[]): Promise<string> {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  const priorExitCode = process.exitCode
  await main(argv, '/tmp/repo')
  expect(process.exitCode).toBe(1)
  process.exitCode = priorExitCode
  return [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')
}

function launchCalls(): unknown[][] {
  return callMock.mock.calls.filter(
    ([method]) => method === 'agent.launch' || method === 'worktree.create'
  )
}

describe('orca cli agent launch', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('starts an agent in the current worktree through agent.launch', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo', 'main', 'abc', 'repo-1')]),
      agentLaunchHostFixture(),
      agentLaunchFixture(WORKTREE_ID)
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'agent',
        'launch',
        '--agent',
        'codex',
        '--model',
        'gpt-5.5',
        '--effort',
        'high',
        '--prompt',
        'Write the design doc',
        '--json'
      ],
      '/tmp/repo/src'
    )

    expect(callMock).toHaveBeenNthCalledWith(3, 'agent.launch', {
      target: { kind: 'existing', worktree: `id:${WORKTREE_ID}` },
      presentation: 'background',
      agent: 'codex',
      prompt: { text: 'Write the design doc', delivery: 'submit' },
      sessionOptions: { model: 'gpt-5.5', effort: 'high' },
      launchSource: 'cli'
    })
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0])).result.receipt.reason).toBe('user_default')
  })

  it('switches to the new tab only with --focus', async () => {
    queueFixtures(callMock, agentLaunchHostFixture(), agentLaunchFixture(WORKTREE_ID))
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['agent', 'launch', '--agent', 'claude', '--worktree', `id:${WORKTREE_ID}`, '--focus'],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('agent.launch', {
      target: { kind: 'existing', worktree: `id:${WORKTREE_ID}` },
      presentation: 'focused',
      agent: 'claude',
      launchSource: 'cli'
    })
  })

  it('refuses on a host older than agent.launch instead of opening a terminal', async () => {
    queueFixtures(callMock, okFixture('req_status', { capabilities: [] }))

    const output = await runRefused([
      'agent',
      'launch',
      '--agent',
      'codex',
      '--worktree',
      `id:${WORKTREE_ID}`,
      '--json'
    ])

    expect(output).toContain('cannot start agents from the CLI')
    expect(launchCalls()).toEqual([])
  })

  it('passes model and effort with a new worktree', async () => {
    queueFixtures(
      callMock,
      agentLaunchHostFixture(),
      agentLaunchFixture('repo-1::/tmp/repo/design'),
      okFixture('req_show', {
        worktree: buildWorktree('/tmp/repo/design', 'design', 'abc', 'repo-1')
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'worktree',
        'create',
        '--repo',
        'id:repo-1',
        '--name',
        'design',
        '--no-parent',
        '--agent',
        'codex',
        '--model',
        'gpt-5.5',
        '--effort',
        'high',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith(
      'agent.launch',
      expect.objectContaining({
        agent: 'codex',
        sessionOptions: { model: 'gpt-5.5', effort: 'high' }
      })
    )
  })

  it('refuses a model on a host older than agent.launch rather than dropping it', async () => {
    queueFixtures(callMock, okFixture('req_status', { capabilities: [] }))

    const output = await runRefused([
      'worktree',
      'create',
      '--repo',
      'id:repo-1',
      '--name',
      'design',
      '--no-parent',
      '--agent',
      'codex',
      '--model',
      'gpt-5.5',
      '--json'
    ])

    expect(output).toContain('cannot start an agent on a chosen model or effort')
    expect(launchCalls()).toEqual([])
  })

  it.each([
    [['--agent', 'codex', '--effort', 'high'], '--effort requires --model'],
    [['--model', 'gpt-5.5'], '--model requires --agent'],
    [['--agent', 'codex', '--model', 'gpt-5.5', '--effort', 'turbo'], 'does not support effort']
  ])('refuses %j before creating anything', async (flags, message) => {
    const output = await runRefused([
      'worktree',
      'create',
      '--repo',
      'id:repo-1',
      '--name',
      'design',
      '--no-parent',
      ...flags,
      '--json'
    ])

    expect(output).toContain(message)
    expect(callMock).not.toHaveBeenCalled()
  })
})
