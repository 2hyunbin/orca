import { structuredJournalBackgroundReady } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import './unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../shared/protocol-version'
import { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationDb } from '../orchestration/db'
import {
  defineMethod,
  defineStreamingMethod,
  type RpcAnyMethodDeclaration,
  type RpcRequest,
  type RpcResponse
} from './core'
import { RpcDispatcher } from './dispatcher'
import { OrchestrationLegacyCompatibility } from './orchestration-legacy-compatibility'
import {
  attachMutationReplayNudge,
  stripMutationReplayNudge
} from './orchestration-mutation-receipt'

type Transport = 'dispatch' | 'streaming'
const TRANSPORTS: readonly Transport[] = ['dispatch', 'streaming']
const AnyParams = z.record(z.string(), z.unknown())
const databases: OrchestrationDb[] = []

afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
  vi.restoreAllMocks()
})

function createDispatcher(methods: readonly RpcAnyMethodDeclaration[]): RpcDispatcher {
  const db = new OrchestrationDb(':memory:')
  databases.push(db)
  const runtime = new OrcaRuntimeService()
  runtime.syncWindowGraph(1, {
    tabs: [],
    leaves: [],
    rendererGeneration: 'rpc-fixture',
    startupRestorationReady: true
  })
  runtime.setOrchestrationDb(db)
  vi.spyOn(runtime, 'getTerminalPromptRequestBinding').mockReturnValue({
    ptyId: 'pty-prompt',
    processIncarnation: 'incarnation-1',
    generation: 1
  })
  vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue('window-1:leaf-prompt')
  return new RpcDispatcher({ runtime, methods })
}

async function call(
  dispatcher: RpcDispatcher,
  transport: Transport,
  request: RpcRequest,
  options?: Parameters<RpcDispatcher['dispatch']>[1]
): Promise<RpcResponse> {
  if (transport === 'dispatch') {
    return dispatcher.dispatch(request, options)
  }
  const replies: string[] = []
  await dispatcher.dispatchStreaming(request, (reply) => replies.push(reply), options)
  return JSON.parse(replies[0]!)
}

function mutationRequest(method: string, params: unknown, requestId: string): RpcRequest {
  return {
    id: `rpc-${requestId}`,
    authToken: 'token',
    method,
    orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
    orchestrationRequestId: requestId,
    params
  }
}

describe('RpcDispatcher unary transport parity', () => {
  it.each(TRANSPORTS)('keeps an ambiguous prompt receipt over %s', async (transport) => {
    const handler = vi.fn((_params: unknown, ctx: { markMutationEffectPossible?: () => void }) => {
      ctx.markMutationEffectPossible?.()
      throw new Error('terminal_not_writable')
    })
    const dispatcher = createDispatcher([
      defineMethod({ name: 'terminal.send', permission: 'workspace', params: AnyParams, handler })
    ])
    const request = mutationRequest(
      'terminal.send',
      {
        terminal: 'term-prompt',
        text: 'go',
        enter: true,
        agentPrompt: true,
        client: { id: 'orca-cli', type: 'desktop' }
      },
      'post-write'
    )

    await expect(call(dispatcher, transport, request)).resolves.toMatchObject({ ok: false })
    await expect(call(dispatcher, transport, request)).resolves.toMatchObject({
      ok: false,
      error: { code: 'operation_unknown' }
    })
    expect(handler).toHaveBeenCalledOnce()
  })

  it('returns the same de-nudged replay receipt over both transports', async () => {
    const replays = await Promise.all(
      TRANSPORTS.map(async (transport) => {
        const dispatcher = createDispatcher([
          defineMethod({
            name: 'orchestration.send',
            permission: 'workspace',
            params: AnyParams,
            handler: (_params, { replayedMutationReceipt }) =>
              replayedMutationReceipt
                ? stripMutationReplayNudge(replayedMutationReceipt)
                : attachMutationReplayNudge(
                    { messageId: 'msg_1' },
                    { kind: 'messages', targets: [{ to: 'term_peer', type: 'status' }] }
                  )
          })
        ])
        const request = mutationRequest('orchestration.send', { to: 'term_peer' }, 'send-1')
        await call(dispatcher, transport, request)
        return call(dispatcher, transport, request)
      })
    )

    const results = replays.map((reply) => (reply.ok ? reply.result : reply.error))
    expect(results[0]).toEqual({
      messageId: 'msg_1',
      mutation: { requestId: 'send-1', replayed: true }
    })
    expect(results[1]).toEqual(results[0])
  })

  it.each(TRANSPORTS)(
    'passes a legacy coordinator fingerprint over an authenticated %s caller',
    async (transport) => {
      vi.spyOn(OrchestrationLegacyCompatibility.prototype, 'tryHandle').mockResolvedValue({
        handled: false
      })
      vi.spyOn(
        OrchestrationLegacyCompatibility.prototype,
        'createCoordinatorInvocation'
      ).mockReturnValue({
        authority: {
          runId: 'run_1',
          principalId: null,
          terminalHandle: 'term_coord',
          paneKey: 'tab:leaf',
          consumerGeneration: 0
        },
        mutationCallerFingerprint: 'legacy-fingerprint',
        revalidate: () => 'run_1'
      })
      const seen: (string | undefined)[] = []
      const dispatcher = createDispatcher([
        defineMethod({
          name: 'orchestration.taskList',
          permission: 'workspace',
          params: null,
          handler: (_params, { authenticatedCallerFingerprint }) => {
            seen.push(authenticatedCallerFingerprint)
            return {}
          }
        })
      ])

      await call(
        dispatcher,
        transport,
        { id: 'rpc-1', authToken: 'token', method: 'orchestration.taskList' },
        { authenticatedCallerFingerprint: 'transport-fingerprint' }
      )
      expect(seen).toEqual(['legacy-fingerprint'])
    }
  )

  it('refuses a streaming method over one-shot dispatch for a pinned non-owner caller', async () => {
    const dispatcher = new RpcDispatcher({
      runtime: new OrcaRuntimeService(),
      methods: [
        defineStreamingMethod({
          name: 'terminal.read',
          permission: 'workspace',
          params: z.object({ terminal: z.string() }),
          handler: async () => {}
        })
      ],
      callerScope: { kind: 'runtime-paired', grants: [] }
    })

    await expect(
      dispatcher.dispatch({
        id: 'rpc-1',
        authToken: 'token',
        method: 'terminal.read',
        params: { terminal: 'term_elsewhere' }
      })
    ).resolves.toMatchObject({ ok: false, error: { code: 'method_not_supported' } })
  })
})

it.each(TRANSPORTS)(
  'keeps upgrade work paused through the complete awaited %s unary invocation and errors',
  async (transport) => {
    for (const fail of [false, true]) {
      const entered = Promise.withResolvers<void>()
      const finish = Promise.withResolvers<void>()
      const dispatcher = createDispatcher([
        defineMethod({
          name: 'worktree.list',
          permission: 'workspace',
          params: AnyParams,
          handler: async () => {
            entered.resolve()
            await finish.promise
            if (fail) {
              throw new Error('user operation failed')
            }
            return { done: true }
          }
        })
      ])
      const result = call(dispatcher, transport, {
        id: 'foreground',
        authToken: 'token',
        method: 'worktree.list',
        params: {}
      })
      await entered.promise
      expect(structuredJournalBackgroundReady()).toBe(false)
      finish.resolve()
      expect(await result).toMatchObject({ ok: !fail })
      expect(structuredJournalBackgroundReady()).toBe(true)
    }
  }
)
