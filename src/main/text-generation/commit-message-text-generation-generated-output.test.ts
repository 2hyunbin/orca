import { ChildProcess, spawn } from 'node:child_process'
import { PassThrough } from 'node:stream'
import type * as ChildProcessModule from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  generateCommitMessageFromContext,
  generatePullRequestFieldsFromContext,
  trimGeneratedCommitMessage
} from './commit-message-text-generation'
import { sourceShapedKimiOutput } from '../../shared/__fixtures__/kimi-generation-source-shaped'
import { finalizeFromAgentOutput } from './source-control-agent-failure'
import {
  generateCommitMessage,
  generateBranchName,
  generatePullRequestFields
} from './source-control-text-generation-requests'
import type {
  CommitMessageGenerationTarget,
  SpawnSourceControlAgent
} from './source-control-text-generation-types'

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>()
  return {
    ...actual,
    spawn: vi.fn(actual.spawn)
  }
})

const spawnMock = vi.mocked(spawn)

function kimiExecution(kind: 'local' | 'remote', stdout: string) {
  const spawnAgent: SpawnSourceControlAgent = ({ args }) => {
    expect(args).toContain('stream-json')
    const child = new (class extends ChildProcess {
      override stdin = new PassThrough()
      override stdout = new PassThrough()
      override stderr = new PassThrough()
    })()
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from(stdout))
      child.emit('close', 0)
    })
    return child
  }
  const target: CommitMessageGenerationTarget = kind === 'local'
    ? { kind, cwd: '/repo' }
    : {
        kind, cwd: '/repo', missingBinaryLocation: 'remote PATH',
        execute: async (plan) => {
          expect(plan.outputFormat).toBe('kimi-stream-json')
          expect(plan.args).toContain('stream-json')
          return { stdout, stderr: '', exitCode: 0, timedOut: false }
        }
      }
  return { target, spawnAgent }
}

beforeEach(() => {
  spawnMock.mockClear()
})

describe('generateCommitMessageFromContext', () => {
  it('preserves the structured subject and body when formatting the final response', async () => {
    const result = await generateCommitMessageFromContext(
      {
        branch: 'main',
        stagedSummary: 'M\tREADME.md',
        stagedPatch: '+hello'
      },
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'agent'
      },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async () => ({
          stdout: 'Update README.\n\n- Explain the generated commit-message flow\n',
          stderr: '',
          exitCode: 0,
          timedOut: false
        })
      }
    )

    expect(result).toEqual({
      success: true,
      message: 'Update README\n\n- Explain the generated commit-message flow',
      agentLabel: 'agent'
    })
  })

  it('drops prefilled reasoning from a custom command but not from a built-in agent', async () => {
    const stdout =
      "We need the message only.\r\nLet's final.</think>Fix typo in README.md\r\n\r\n- Correct spelling\r\n"
    const generate = (params: { agentId: 'custom' | 'claude'; model: string }) =>
      generateCommitMessageFromContext(
        { branch: 'main', stagedSummary: 'M\tREADME.md', stagedPatch: '+hello' },
        { ...params, customAgentCommand: 'llama-completion' },
        {
          kind: 'remote',
          cwd: '/repo',
          missingBinaryLocation: 'remote PATH',
          execute: async () => ({ stdout, stderr: '', exitCode: 0, timedOut: false })
        }
      )

    await expect(generate({ agentId: 'custom', model: '' })).resolves.toEqual({
      success: true,
      message: 'Fix typo in README.md\n\n- Correct spelling',
      agentLabel: 'llama-completion'
    })
    await expect(generate({ agentId: 'claude', model: 'sonnet' })).resolves.toMatchObject({
      success: true,
      message: expect.stringContaining("Let's final.</think>Fix typo in README.md")
    })
  })

  it('reports a custom command that printed only reasoning as an empty message', async () => {
    const result = await generateCommitMessageFromContext(
      { branch: 'main', stagedSummary: 'M\tREADME.md', stagedPatch: '+hello' },
      { agentId: 'custom', model: '', customAgentCommand: 'agent' },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async () => ({
          stdout: 'Still reasoning.</think>\n',
          stderr: '',
          exitCode: 0,
          timedOut: false
        })
      }
    )

    expect(result).toEqual({ success: false, error: 'agent returned an empty message.' })
  })

  it('reports empty remote commit-message output as an empty message', async () => {
    let operation = ''
    const result = await generateCommitMessageFromContext(
      {
        branch: 'main',
        stagedSummary: 'M\tREADME.md',
        stagedPatch: '+hello'
      },
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'agent'
      },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async (_plan, _cwd, _timeoutMs, requestedOperation) => {
          operation = requestedOperation
          return {
            stdout: '   \n',
            stderr: '',
            exitCode: 0,
            timedOut: false
          }
        }
      }
    )

    expect(operation).toBe('commit-message')
    expect(result).toEqual({
      success: false,
      error: 'agent returned an empty message.'
    })
  })

  it('keeps custom-command PR JSON that quotes a lone closing tag, and strips reasoning otherwise', async () => {
    const generate = (stdout: string) =>
      generatePullRequestFieldsFromContext(
        {
          branch: 'feature/pr-fields',
          base: 'main',
          branchChangedByPreparation: false,
          currentTitle: '',
          currentBody: '',
          currentDraft: false,
          commitSummary: '- feat: update README',
          changeSummary: 'M\tREADME.md',
          patch: '+hello'
        },
        { agentId: 'custom', model: '', customAgentCommand: 'agent' },
        {
          kind: 'remote',
          cwd: '/repo',
          missingBinaryLocation: 'remote PATH',
          execute: async () => ({ stdout, stderr: '', exitCode: 0, timedOut: false })
        }
      )
    const json = '{"title":"Strip </think> from output","body":"Drops reasoning.","draft":false}'

    await expect(generate(json)).resolves.toMatchObject({
      success: true,
      fields: { title: 'Strip </think> from output', body: 'Drops reasoning.' }
    })
    await expect(generate(`Need JSON only.</think>\n${json}`)).resolves.toMatchObject({
      success: true,
      fields: { title: 'Strip </think> from output' }
    })
  })

  it('reports empty remote pull-request field output as empty details', async () => {
    let operation = ''
    const result = await generatePullRequestFieldsFromContext(
      {
        branch: 'feature/pr-fields',
        base: 'main',
        branchChangedByPreparation: false,
        currentTitle: '',
        currentBody: '',
        currentDraft: false,
        commitSummary: '- feat: update README',
        changeSummary: 'M\tREADME.md',
        patch: '+hello'
      },
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'agent'
      },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async (_plan, _cwd, _timeoutMs, requestedOperation) => {
          operation = requestedOperation
          return {
            stdout: '   \n',
            stderr: '',
            exitCode: 0,
            timedOut: false
          }
        }
      }
    )

    expect(operation).toBe('pull-request-fields')
    expect(result).toEqual({
      success: false,
      error: 'agent returned an empty details.',
      branchChangedByPreparation: false
    })
  })

  it('reports branch changes when pull request field output cannot be parsed', async () => {
    const listeners = new Map<string, (value: unknown) => void>()
    spawnMock.mockReturnValue({
      pid: 123,
      kill: vi.fn(),
      stdout: { on: vi.fn((event, callback) => listeners.set(`stdout:${event}`, callback)) },
      stderr: { on: vi.fn((event, callback) => listeners.set(`stderr:${event}`, callback)) },
      stdin: { end: vi.fn() },
      on: vi.fn((event, callback) => listeners.set(event, callback))
    } as never)

    const pullRequest = generatePullRequestFieldsFromContext(
      {
        branch: 'feature/pr-fields',
        base: 'main',
        branchChangedByPreparation: true,
        currentTitle: '',
        currentBody: '',
        currentDraft: false,
        commitSummary: '- feat: update README',
        changeSummary: 'M\tREADME.md',
        patch: '+hello'
      },
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'agent'
      },
      {
        kind: 'local',
        cwd: '/repo'
      }
    )

    listeners.get('stdout:data')?.(Buffer.from('not json'))
    listeners.get('close')?.(0)

    await expect(pullRequest).resolves.toEqual({
      success: false,
      error: 'Generated pull request details could not be parsed.',
      branchChangedByPreparation: true
    })
  })
})

describe('trimGeneratedCommitMessage', () => {
  it('removes trailing whitespace from generated messages', () => {
    const message = trimGeneratedCommitMessage('Update docs\n\n')

    expect(message).toBe('Update docs')
  })
})

describe.each(['local', 'remote'] as const)('Kimi %s generation consumers', (kind) => {
  const params = { agentId: 'kimi' as const, model: 'default' }
  const prContext = {
    branch: 'feature/login', base: 'main', branchChangedByPreparation: true,
    currentTitle: '', currentBody: '', currentDraft: false,
    commitSummary: '- Fix login', changeSummary: 'M file.ts', patch: '+fix'
  }

  it('decodes hooks, tool narration, metadata and multiline commit content once', async () => {
    const result = await generateCommitMessage({
      context: { branch: 'main', stagedSummary: 'M file.ts', stagedPatch: '+fix' }, params,
      ...kimiExecution(kind, sourceShapedKimiOutput('Fix login\n\n- Handle expired tokens'))
    })
    expect(result).toEqual({
      success: true, message: 'Fix login\n\n- Handle expired tokens', agentLabel: 'Kimi'
    })
    const literal = '{"role":"tool","content":"example"}'
    expect(await generateCommitMessage({
      context: { branch: 'main', stagedSummary: 'M file.ts', stagedPatch: '+fix' }, params,
      ...kimiExecution(kind, sourceShapedKimiOutput(literal))
    })).toMatchObject({ success: true, message: literal })
  })

  it('delivers only the final branch slug and refuses damaged output before naming', async () => {
    const run = (stdout: string) => generateBranchName({
      context: { firstPrompt: 'Fix login' }, params, ...kimiExecution(kind, stdout)
    })
    expect(await run(sourceShapedKimiOutput('Fix/Login Flow'))).toMatchObject({
      success: true, slug: 'fix-login-flow'
    })
    expect(await run(`${sourceShapedKimiOutput('fix-login')}\n{"role":`)).toMatchObject({
      success: false, error: "Kimi returned output Orca couldn't read. Try again."
    })
  })

  it('parses nested PR fields and keeps preparation metadata on protocol failure', async () => {
    const fields = { title: 'Fix login', body: 'Handle expiry.\n\nKeep sessions.', base: 'main', draft: true }
    const run = (stdout: string) => generatePullRequestFields({
      context: prContext, params, ...kimiExecution(kind, stdout)
    })
    expect(await run(sourceShapedKimiOutput(JSON.stringify(fields)))).toMatchObject({
      success: true, fields, branchChangedByPreparation: true
    })
    expect(await run('not JSON')).toMatchObject({
      success: false, branchChangedByPreparation: true,
      error: "Kimi returned output Orca couldn't read. Try again."
    })
  })
})

describe('selected generation protocols', () => {
  const finalize = (stdout: string, code = 0) => finalizeFromAgentOutput({
    stdout, code, stderr: '', label: 'Kimi', emptyResultName: 'message', outputFormat: 'kimi-stream-json'
  })

  it.each([
    '{"role":', 'NOTICE wrapper log', 'null', '{"content":"missing role"}',
    '{"role":"assistant","content":42}', '{"role":"assistant"}',
    '{"role":"assistant","content":"narration","tool_calls":"bad"}',
    '{"role":"assistant","tool_calls":[{"type":"function","id":"tc","function":{"name":"Shell","arguments":{}}}]}',
    '{"role":"tool","content":"missing tool id"}'
  ])('rejects malformed selected records after an earlier answer: %s', (badLine) => {
    const result = finalize(`${sourceShapedKimiOutput('Earlier answer')}\n${badLine}`)
    expect(result).toMatchObject({
      success: false, error: "Kimi returned output Orca couldn't read. Try again."
    })
  })

  it('rejects tool-only and unfinished tool turns, and keeps exit status authoritative', () => {
    for (const stdout of [
      sourceShapedKimiOutput(),
      '{"role":"tool","tool_call_id":"tc","content":"no answer"}', ''
    ]) {
      expect(finalize(stdout)).toMatchObject({ success: false, error: 'Kimi returned an empty message.' })
    }
    expect(finalize(sourceShapedKimiOutput('Do not accept this'), 1)).toMatchObject({
      success: false, error: 'Kimi CLI command failed with code 1.'
    })
  })

  it.each([
    ['custom', '', 'kimi', undefined], ['claude', 'sonnet', undefined, undefined],
    ['opencode', 'provider/model', undefined, undefined], ['kimi', 'default', undefined, '--output-format text']
  ] as const)('preserves literal role JSON through %s finalization and commit cleanup', async (agentId, model, customAgentCommand, agentArgs) => {
    const literal = '{"role":"assistant","content":"example"}'
    const result = await generateCommitMessageFromContext(
      { branch: 'main', stagedSummary: 'M file', stagedPatch: '+fix' },
      { agentId, model, customAgentCommand, agentArgs },
      {
        kind: 'remote', cwd: '/repo', missingBinaryLocation: 'remote PATH',
        execute: async () => ({
          stdout: agentId === 'opencode'
            ? JSON.stringify({ type: 'text', part: { text: literal } }) : literal,
          stderr: '', exitCode: 0, timedOut: false
        })
      }
    )
    expect(result).toMatchObject({ success: true, message: literal })
  })
})
