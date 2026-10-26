import type { ZodType } from 'zod'
import { throwIfSignalAborted, waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'
import {
  buildRegistry,
  isStreamingMethod,
  type RpcAnyMethodDeclaration,
  type RpcContext,
  type RpcTypedMethod
} from './core'
import type { RpcMethodPermission } from './rpc-method-permission'

export type RpcMethodMetadata = {
  readonly name: string
  readonly permission: RpcMethodPermission
  readonly params: ZodType | null
  readonly stream?: true
}

type DeclaredRpcMethodMetadata<M extends RpcAnyMethodDeclaration> = M extends {
  readonly stream: true
}
  ? Pick<M, 'name' | 'permission' | 'params' | 'stream'>
  : Pick<M, 'name' | 'permission' | 'params'> & { readonly stream?: never }

type LazyRpcMethod<M extends RpcAnyMethodDeclaration> = M extends { readonly stream: true }
  ? M
  : M extends RpcTypedMethod<infer N, infer S, infer R>
    ? RpcTypedMethod<N, S, Promise<Awaited<R>>>
    : never

export function lazyRpcMethods<M extends RpcAnyMethodDeclaration>(
  metadata: readonly NoInfer<DeclaredRpcMethodMetadata<M>>[],
  load: () => Promise<readonly M[]>
): readonly LazyRpcMethod<M>[]
export function lazyRpcMethods(
  metadata: readonly RpcMethodMetadata[],
  load: () => Promise<readonly RpcAnyMethodDeclaration[]>
): readonly RpcAnyMethodDeclaration[] {
  let pending: Promise<ReturnType<typeof buildRegistry>> | undefined
  const registry = () => {
    pending ??= Promise.resolve()
      .then(load)
      .then((methods) => {
        const loaded = buildRegistry(methods)
        if (
          methods.length !== metadata.length ||
          metadata.some((entry, index) => {
            const method = methods[index]
            return (
              !method ||
              method.name !== entry.name ||
              method.permission !== entry.permission ||
              method.params !== entry.params ||
              ('stream' in method && method.stream === true) !== (entry.stream === true)
            )
          })
        ) {
          throw new Error(`rpc_method_metadata_mismatch:${metadata[0]?.name ?? 'empty'}`)
        }
        return loaded
      })
      .catch((error: unknown) => {
        pending = undefined
        throw error
      })
    return pending
  }
  const methods = metadata.map((entry) =>
    entry.stream
      ? {
          ...entry,
          stream: true as const,
          handler: async (
            params: unknown,
            context: RpcContext,
            emit: (result: unknown) => void
          ) => {
            throwIfSignalAborted(context.signal)
            const loaded = await waitForPromiseWithSignal(registry(), context.signal)
            throwIfSignalAborted(context.signal)
            const method = loaded.get(entry.name)
            if (!method || !isStreamingMethod(method)) {
              throw new Error(`rpc_streaming_method_missing:${entry.name}`)
            }
            await method.handler(params, context, emit)
          }
        }
      : {
          ...entry,
          handler: async (params: unknown, context: RpcContext) => {
            const method = (await registry()).get(entry.name)
            if (!method || isStreamingMethod(method)) {
              throw new Error(`rpc_method_missing:${entry.name}`)
            }
            return method.handler(params, context)
          }
        }
  )
  return methods
}
