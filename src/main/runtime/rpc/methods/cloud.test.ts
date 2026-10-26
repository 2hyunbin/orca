import { describe, expect, it, vi } from 'vitest'
import { eraseRpcMethods, type RpcContext } from '../core'
import { CLOUD_METHODS } from './cloud'

const methods = eraseRpcMethods(CLOUD_METHODS)
const cloud = {
  status: vi.fn(() => ({ enabled: true, link: null })),
  beginSignIn: vi.fn(),
  finishSignIn: vi.fn(),
  signOut: vi.fn()
}

function contextFor(clientKind: RpcContext['clientKind']): RpcContext {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these handlers read only getConnectorCloud from the runtime.
  return { runtime: { getConnectorCloud: () => cloud }, clientKind } as unknown as RpcContext
}

function method(name: string) {
  const found = methods.find((candidate) => candidate.name === name)
  if (!found) {
    throw new Error(`Missing cloud method: ${name}`)
  }
  return found
}

describe('cloud RPC methods', () => {
  it.each(['cloud.status', 'cloud.beginSignIn', 'cloud.finishSignIn', 'cloud.signOut'])(
    '%s refuses every paired client',
    async (name) => {
      for (const clientKind of ['mobile', 'runtime'] as const) {
        await expect(
          Promise.resolve().then(() =>
            method(name).handler({ flowId: 'f', name: 'box' }, contextFor(clientKind))
          )
        ).rejects.toThrow('Run `orca cloud` on the Orca host itself.')
      }
      expect(cloud.status).not.toHaveBeenCalled()
    }
  )

  it('hands the caller signal to finishSignIn so a closed CLI cancels the sign-in', async () => {
    const context = { ...contextFor(undefined), signal: new AbortController().signal }
    await method('cloud.finishSignIn').handler({ flowId: 'flow-1' }, context)
    expect(cloud.finishSignIn).toHaveBeenCalledWith('flow-1', context.signal)
  })
})
