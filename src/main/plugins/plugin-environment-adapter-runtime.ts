import { join } from 'node:path'
import { SERVER_TARGETS } from '../../shared/node-runtime-pin'
import { detectNativeHostAbi, nativeSlotName } from '../orcad/native-host-abi'
import { materializeCachedNodeRuntime } from '../node-runtime/pinned-runtime-materializer'
import type { EnvironmentAdapterRuntime } from './plugin-environment-adapter-launch'

export function environmentAdapterRuntime(userDataPath: string): EnvironmentAdapterRuntime {
  return async (signal) => {
    const slot = nativeSlotName(detectNativeHostAbi())
    const target = SERVER_TARGETS.find((candidate) => candidate === slot)
    if (!target) {
      throw new Error('This control host has no supported Node adapter runtime')
    }
    return materializeCachedNodeRuntime(target, join(userDataPath, 'orcad-artifacts'), { signal })
  }
}
