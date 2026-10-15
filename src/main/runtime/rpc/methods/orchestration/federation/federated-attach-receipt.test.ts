import { describe, expect, it } from 'vitest'
import { parseRemoteFederatedWorkerStartReceipt } from './federated-attach-receipt'

describe('remote federated worker start receipt', () => {
  it.each([
    { name: 'missing runtime epoch', receipt: {} },
    { name: 'non-string runtime epoch', receipt: { runtimeEpoch: 42 } },
    { name: 'missing worktree id', receipt: { runtimeEpoch: 'epoch_remote' } },
    {
      name: 'missing terminal handle',
      receipt: {
        runtimeEpoch: 'epoch_remote',
        worktreeId: 'worktree_remote',
        terminalHandle: undefined
      }
    }
  ])('rejects a ready receipt with $name', ({ receipt }) => {
    expect(() =>
      parseRemoteFederatedWorkerStartReceipt({
        dispatchId: 'ctx_remote',
        state: 'ready',
        terminalHandle: 'term_remote',
        ...receipt
      })
    ).toThrow('invalid ready receipt')
  })

  it('accepts a non-ready receipt without ready-only resources', () => {
    expect(
      parseRemoteFederatedWorkerStartReceipt({
        dispatchId: 'ctx_remote',
        state: 'outcome_unknown'
      })
    ).toMatchObject({ dispatchId: 'ctx_remote', state: 'outcome_unknown' })
  })

  it('accepts the receiving host structured identity and mode beside the compatibility handle', () => {
    expect(
      parseRemoteFederatedWorkerStartReceipt(
        {
          dispatchId: 'ctx_remote',
          state: 'ready',
          runtimeEpoch: 'epoch_remote',
          worktreeId: 'worktree_remote',
          terminalHandle: 'structworker_remote',
          agentSession: {
            kind: 'structured',
            handle: 'structworker_remote',
            sessionId: 'session_remote'
          },
          mode: {
            mode: 'structured',
            preferred: 'structured',
            reason: 'user_default',
            detail: 'Chat default.'
          }
        },
        { supportsAgentSession: true }
      )
    ).toMatchObject({ agentSession: { kind: 'structured', sessionId: 'session_remote' } })
  })

  it('rejects a capable peer that claims ready without the matching session and mode', () => {
    expect(() =>
      parseRemoteFederatedWorkerStartReceipt(
        {
          dispatchId: 'ctx_remote',
          state: 'ready',
          runtimeEpoch: 'epoch_remote',
          worktreeId: 'worktree_remote',
          terminalHandle: 'term_remote',
          agentSession: { kind: 'structured', handle: 'other', sessionId: 'session_remote' },
          mode: {
            mode: 'structured',
            preferred: 'structured',
            reason: 'user_default',
            detail: 'Chat default.'
          }
        },
        { supportsAgentSession: true }
      )
    ).toThrow('invalid agent-session receipt')
  })
})
