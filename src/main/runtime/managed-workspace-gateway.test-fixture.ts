import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { makeStore } from './runtime-rpc-worktree-store-fixtures'
import { ALL_RPC_METHODS } from './rpc/methods'
import { defineMethod, defineStreamingMethod } from './rpc/core'
import { parsePairingCode } from '../../shared/pairing'
import { pairedRuntimeConnectionFromOffer } from '../../shared/paired-runtime-connection'
import { managedRuntimeGatewayPath } from '../../shared/managed-runtime-gateway-contract'
import type { ManagedWorkspaceHosts } from './managed-workspace-gateway-contract'

export async function managedWorkspaceGatewayFixture() {
  const cleanups: (() => Promise<void> | void)[] = []
  const calls = { controller: 0, child: 0 }
  async function server(kind: 'controller' | 'child', previousDirectory?: string) {
    const directory = previousDirectory ?? mkdtempSync(join(tmpdir(), 'orca-workspace-gateway-'))
    if (!previousDirectory) {
      cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The sibling RPC integration fixture's store implements the status and socket surfaces used here.
    const runtime = new OrcaRuntimeService(makeStore() as never)
    const rpc = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath: directory,
      enableWebSocket: true,
      wsPort: 0,
      methods: [
        ...ALL_RPC_METHODS,
        defineMethod({
          name: 'terminal.gatewayProbe',
          permission: 'workspace',
          params: z.record(z.string(), z.unknown()),
          handler: (params, context) => {
            calls[kind]++
            return { kind, params, clientId: context.clientId, runtimeId: runtime.getRuntimeId() }
          }
        }),
        defineStreamingMethod({
          name: 'test.gatewayBinary',
          permission: 'workspace',
          params: null,
          handler: async (_params, context, emit) => {
            calls[kind]++
            const release = context.registerBinaryMessageHandler?.((bytes) =>
              context.sendBinary?.(bytes)
            )
            emit({ type: 'ready', kind })
            try {
              await new Promise<void>((resolve) => {
                if (context.signal?.aborted) {
                  resolve()
                } else {
                  context.signal?.addEventListener('abort', () => resolve(), { once: true })
                }
              })
            } finally {
              release?.()
            }
          }
        })
      ]
    })
    await rpc.start()
    cleanups.push(() => rpc.stop())
    const offer = rpc.createPairingOffer({ address: '127.0.0.1', name: kind, scope: 'runtime' })
    if (!offer.available) {
      throw new Error('pairing unavailable')
    }
    const pairing = parsePairingCode(offer.pairingUrl)
    if (!pairing) {
      throw new Error('invalid pairing')
    }
    return {
      directory,
      rpc,
      runtime,
      pairing,
      connection: pairedRuntimeConnectionFromOffer(pairing)
    }
  }
  try {
    let child = await server('child')
    const controller = await server('controller')
    let current = true
    let generation = 1
    let retire: ((id: string) => void) | undefined
    let resolveGate: Promise<void> = Promise.resolve()
    let resolving = 0
    let closedHosts = 0
    const hosts: ManagedWorkspaceHosts = {
      resolve: async (route) => {
        resolving++
        await resolveGate
        if (route.environmentId !== 'devbox' || route.targetGeneration !== generation || !current) {
          throw new Error('stale managed target')
        }
        return {
          connection: child.connection,
          runtimeId: child.runtime.getRuntimeId(),
          isCurrent: () => current && route.targetGeneration === generation,
          close: () => {
            closedHosts++
          }
        }
      },
      onRetired: (listener) => {
        retire = listener
        return () => {
          retire = undefined
        }
      }
    }
    controller.rpc.setManagedWorkspaceHosts(hosts)
    const gateway = {
      ...controller.connection,
      endpoint:
        controller.connection.endpoint.replace(/\/$/u, '') + managedRuntimeGatewayPath('devbox', 1)
    }
    return {
      calls,
      get child() {
        return child
      },
      controller,
      gateway,
      restartChild: async () => {
        const previous = child
        await previous.rpc.stop()
        child = await server('child', previous.directory)
        child.connection = { ...previous.connection, endpoint: child.connection.endpoint }
      },
      resolving: () => resolving,
      closedHosts: () => closedHosts,
      retire: () => {
        current = false
        retire?.('devbox')
      },
      changeGeneration: () => {
        generation++
      },
      delayResolve: (gate: Promise<void>) => {
        resolveGate = gate
      },
      close: async () => {
        for (const cleanup of cleanups.splice(0).toReversed()) {
          await cleanup()
        }
      }
    }
  } catch (error) {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup()
    }
    throw error
  }
}
