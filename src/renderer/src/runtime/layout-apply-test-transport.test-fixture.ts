// A stand-in for main's `layout.apply` and `layout.subscribe` in switch-on renderer tests. It answers
// each command the window sends (accept, apply to main's model, leave pending, or refuse) and, when
// applying, emits main's frame at the reply's stream position, as main does.
//
// Install it in a test file, before any import that reaches the RPC client:
//   vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
//     (await import('@/runtime/layout-apply-test-transport.test-fixture'))
//       .runtimeRpcClientWithLayoutApply(await importOriginal()))
// and, for frames, `@/runtime/runtime-layout-client` with `runtimeLayoutClientWithTestFrames`.
// Imports stay clear of the RPC client at runtime: a mock factory must not reach what it replaces.

import { createBrowserUuid } from '@/lib/browser-uuid'
import { applyLayoutCommand } from '../../../shared/workspace-layout/workspace-layout-commands'
import type {
  LayoutApplyReply,
  LayoutCommand,
  LayoutCommandResult
} from '../../../shared/workspace-layout/workspace-layout-command-types'
import type { WorkspaceLayoutModel } from '../../../shared/workspace-layout/workspace-layout-model'
import { publishWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-published'
import type { WorkspaceLayoutChangeFrame } from '../../../shared/workspace-layout/workspace-layout-stream-frames'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { layoutSnapshotFrame, publishedLayoutsOf } from './main-loaded-layout-frames.test-fixture'
import type * as LayoutClient from './runtime-layout-client'
import type * as RpcClient from './runtime-rpc-client'

type Refusal = Extract<LayoutApplyReply, { ok: false }>['code']

/**
 * `accept`: ok, with a result naming the ids the command did; no frame (main's copy is not
 * modelled). `apply`: main's model (`useMainModel`) applies it; the reply carries its real result
 * and the position of the frame emitted with it. `pending`: no answer until `answerPending`.
 */
export type LayoutApplyTestAnswer =
  | 'accept'
  | 'apply'
  | 'pending'
  | { refuse: Refusal }
  | ((command: LayoutCommand) => LayoutApplyReply | 'pending')

type FrameSink = {
  onFrame: (frame: WorkspaceLayoutChangeFrame) => void
  onPosition?: (seq: number) => void
}

type PendingApply = { command: LayoutCommand; resolve: (reply: LayoutApplyReply) => void }

type TransportState = {
  answer: LayoutApplyTestAnswer
  sent: LayoutCommand[]
  pending: PendingApply[]
  model: WorkspaceLayoutModel | null
  seq: number
  sinks: Set<FrameSink>
  inFlight: Promise<LayoutApplyReply>[]
}

const fresh = (): TransportState => ({
  answer: 'accept',
  sent: [],
  pending: [],
  model: null,
  seq: 0,
  sinks: new Set(),
  inFlight: []
})

let state = fresh()

const ID_FIELDS = ['tabId', 'leafId', 'groupId', 'pageId'] as const

/** What main's result names for a command it accepted, read off the command. */
function acceptedResult(command: LayoutCommand): LayoutCommandResult {
  const result: LayoutCommandResult = {}
  for (const field of ID_FIELDS) {
    const value: unknown = Reflect.get(command, field)
    if (typeof value === 'string') {
      result[field] = value
    }
  }
  if (command.type === 'closeTabs') {
    return { ...result, closed: [...command.tabIds], refused: [] }
  }
  if (command.type === 'sleep') {
    return { ...result, slept: [...(command.paneKeys ?? [])] }
  }
  if (command.type === 'wake') {
    return { ...result, woken: [...(command.paneKeys ?? [])] }
  }
  if (command.type === 'splitPane' && command.newLeafId) {
    return { ...result, leafId: command.newLeafId }
  }
  return result
}

// Shape check only: the window's own sender built it.
function isLayoutCommand(value: unknown): value is LayoutCommand {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'type') === 'string' &&
    typeof Reflect.get(value, 'workspace') === 'string'
  )
}

function emit(frame: WorkspaceLayoutChangeFrame): void {
  for (const sink of state.sinks) {
    sink.onFrame(frame)
    if (frame.seq !== undefined) {
      sink.onPosition?.(frame.seq)
    }
  }
}

function applyToMainModel(command: LayoutCommand): LayoutApplyReply {
  const model = state.model
  if (!model) {
    throw new Error('layoutApplyTestTransport: answer "apply" needs useMainModel first')
  }
  const applied = applyLayoutCommand(model, command, {
    mintId: createBrowserUuid,
    mintLeafId: createBrowserUuid,
    now: () => Date.now()
  })
  if (!applied.ok) {
    return applied
  }
  state.model = applied.model
  state.seq += 1
  const seq = state.seq
  const key = command.workspace
  const workspace = applied.model.workspaces[key]
  // Main publishes before it replies.
  emit(
    workspace
      ? { type: 'workspace', key, layout: publishWorkspaceLayout(workspace, model.hostId), seq }
      : { type: 'removed', key, seq }
  )
  return { ok: true, result: applied.result, frameSeq: seq }
}

function answerCommand(command: LayoutCommand): Promise<LayoutApplyReply> {
  state.sent.push(command)
  const answer = state.answer
  const reply =
    typeof answer === 'function'
      ? answer(command)
      : answer === 'accept'
        ? ({ ok: true, result: acceptedResult(command) } satisfies LayoutApplyReply)
        : answer === 'apply'
          ? applyToMainModel(command)
          : answer === 'pending'
            ? 'pending'
            : ({ ok: false, code: answer.refuse } satisfies LayoutApplyReply)
  const answered =
    reply === 'pending'
      ? new Promise<LayoutApplyReply>((resolve) => state.pending.push({ command, resolve }))
      : Promise.resolve(reply)
  if (reply !== 'pending') {
    state.inFlight.push(answered)
  }
  return answered
}

// The sender's reply chain (reply, frame wait, handler) runs a few microtasks after the answer.
const REPLY_CHAIN_TURNS = 5

export const layoutApplyTestTransport = {
  /** How later commands are answered; `accept` after each `reset`. */
  answerWith(answer: LayoutApplyTestAnswer): void {
    state.answer = answer
  },
  /** Main's model, which `apply` edits and frames publish. */
  useMainModel(model: WorkspaceLayoutModel): void {
    state.model = model
  },
  get mainModel(): WorkspaceLayoutModel | null {
    return state.model
  },
  /** Every command sent, in order, with its workspace. */
  get sent(): readonly LayoutCommand[] {
    return state.sent
  },
  sentOfType<T extends LayoutCommand['type']>(type: T): Extract<LayoutCommand, { type: T }>[] {
    return state.sent.filter(
      (command): command is Extract<LayoutCommand, { type: T }> => command.type === type
    )
  },
  get pendingCount(): number {
    return state.pending.length
  },
  /** Answers every pending command: with `reply`, else as the current answer (not `pending`). */
  answerPending(reply?: LayoutApplyReply): void {
    const pending = state.pending
    state.pending = []
    for (const { command, resolve } of pending) {
      const answer =
        reply ??
        (state.answer === 'apply'
          ? applyToMainModel(command)
          : { ok: true as const, result: acceptedResult(command) })
      state.inFlight.push(Promise.resolve(answer))
      resolve(answer)
    }
  },
  /** Resolves once every answered command's handler ran; real or fake timers alike. */
  async settle(): Promise<void> {
    while (state.inFlight.length > 0) {
      const answered = state.inFlight
      state.inFlight = []
      await Promise.all(answered)
      for (let turn = 0; turn < REPLY_CHAIN_TURNS; turn += 1) {
        await Promise.resolve()
      }
    }
  },
  /** Sends a frame main made on its own (a CLI create, a load repair). */
  emitFrame(frame: WorkspaceLayoutChangeFrame): void {
    emit(frame)
  },
  /** Answers one `layout.apply` request's params; the RPC mock below routes here. */
  call(params: unknown): Promise<LayoutApplyReply> {
    const command: unknown =
      typeof params === 'object' && params !== null ? Reflect.get(params, 'command') : undefined
    if (!isLayoutCommand(command)) {
      return Promise.reject(new Error('layout.apply without a command'))
    }
    return answerCommand(command)
  },
  reset(): void {
    state = fresh()
  }
}

type RpcClientModule = typeof RpcClient

/** The RPC client module with local `layout.apply` answered by the transport. */
export function runtimeRpcClientWithLayoutApply(actual: RpcClientModule): RpcClientModule {
  function callRuntimeRpc<TResult>(
    target: RuntimeClientTarget,
    method: string,
    params?: unknown,
    options?: Parameters<RpcClientModule['callRuntimeRpc']>[3]
  ): Promise<TResult> {
    if (target.kind === 'local' && method === 'layout.apply') {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: callers of layout.apply type TResult as LayoutApplyReply.
      return layoutApplyTestTransport.call(params) as Promise<TResult>
    }
    return actual.callRuntimeRpc<TResult>(target, method, params, options)
  }
  return { ...actual, callRuntimeRpc }
}

type LayoutClientModule = typeof LayoutClient

/** The layout client module with the local stream fed by the transport: main's model's snapshot
 *  first, then the frames `apply` and `emitFrame` send. */
export function runtimeLayoutClientWithTestFrames(actual: LayoutClientModule): LayoutClientModule {
  const subscribeRuntimeLayout: LayoutClientModule['subscribeRuntimeLayout'] = (
    target,
    params,
    onFrame,
    onStatus,
    onPosition
  ) => {
    if (target.kind !== 'local') {
      return actual.subscribeRuntimeLayout(target, params, onFrame, onStatus, onPosition)
    }
    const sink: FrameSink = { onFrame, onPosition }
    state.sinks.add(sink)
    onStatus({ state: 'connecting' })
    queueMicrotask(() => {
      if (!state.sinks.has(sink)) {
        return
      }
      onStatus({ state: 'live' })
      onFrame(layoutSnapshotFrame(state.model ? publishedLayoutsOf(state.model) : {}, state.seq))
      onPosition?.(state.seq)
    })
    return {
      close: () => {
        state.sinks.delete(sink)
        onStatus({ state: 'closed' })
      }
    }
  }
  return { ...actual, subscribeRuntimeLayout }
}
