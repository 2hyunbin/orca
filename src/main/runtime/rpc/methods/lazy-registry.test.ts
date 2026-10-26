import { describe, expect, it, vi } from 'vitest'
import { buildRegistry, isStreamingMethod } from '../core'
import { OrcaRuntimeService } from '../../orca-runtime'
import { RPC_METHOD_METADATA } from './method-metadata.generated'
import type * as MethodLoaders from './method-loaders'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../../shared/sidebar-inputs-switch'

vi.mock('./method-loaders', async (importOriginal) => {
  const original = await importOriginal<typeof MethodLoaders>()
  return {
    RPC_METHOD_GROUP_LOADERS: Object.fromEntries(
      Object.entries(original.RPC_METHOD_GROUP_LOADERS).map(([name, load]) => [name, vi.fn(load)])
    )
  }
})

import { RPC_METHOD_GROUP_LOADERS } from './method-loaders'
import { ALL_RPC_METHODS } from './index'

describe('the production lazy RPC registry', () => {
  it('enumerates complete security and schema metadata without loading implementations', () => {
    const registry = buildRegistry(ALL_RPC_METHODS)
    expect(registry.get('aiVault.prepareSessionResume')?.params).not.toBeNull()
    expect(registry.get('computer.click')?.permission).toBe('desktop-control')
    expect(registry.get('runtime.clientEvents.subscribe')).toMatchObject({ stream: true })
    for (const load of Object.values(RPC_METHOD_GROUP_LOADERS)) {
      expect(load).not.toHaveBeenCalled()
    }
  })

  it('loads only the invoked implementation group', async () => {
    const method = buildRegistry(ALL_RPC_METHODS).get('host.platform')
    if (!method || isStreamingMethod(method)) {
      throw new Error('missing host.platform')
    }
    expect(await method.handler(undefined, { runtime: new OrcaRuntimeService() })).toEqual({
      platform: process.platform
    })
    for (const [name, load] of Object.entries(RPC_METHOD_GROUP_LOADERS)) {
      expect(load).toHaveBeenCalledTimes(name === 'HOST_CAPABILITY_METHODS' ? 1 : 0)
    }
  })

  it('matches the original declarations in every group, including dark-build methods', async () => {
    const metadata = new Map(Object.entries(RPC_METHOD_METADATA))
    const advertisedNames: string[] = []
    for (const [group, load] of Object.entries(RPC_METHOD_GROUP_LOADERS)) {
      const declarations = await load()
      const gatedOff =
        (!ORCA_LAYOUT_OWNER_IS_MAIN &&
          (group === 'LAYOUT_APPLY_METHODS' || group === 'LAYOUT_VIEW_REPORT_METHODS')) ||
        (!ORCA_SIDEBAR_INPUTS_IS_MAIN && group === 'SIDEBAR_INPUT_METHODS')
      if (!gatedOff) {
        advertisedNames.push(...declarations.map(({ name }) => name))
      }
      const expected = metadata.get(group)
      expect(expected, group).toBeDefined()
      expect(
        declarations.map(({ name }) => name),
        group
      ).toEqual(expected?.map(({ name }) => name))
      declarations.forEach((method, index) => {
        const entry = expected?.[index]
        expect(method.permission, method.name).toBe(entry?.permission)
        expect(method.params, method.name).toBe(entry?.params)
        expect('stream' in method && method.stream === true, method.name).toBe(
          entry !== undefined && 'stream' in entry && entry.stream === true
        )
      })
    }
    expect(ALL_RPC_METHODS.map(({ name }) => name).sort()).toEqual(advertisedNames.sort())
  })
})
