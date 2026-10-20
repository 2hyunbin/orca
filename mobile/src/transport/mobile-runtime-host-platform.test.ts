import { describe, expect, it } from 'vitest'
import { hostPlatformSchema } from '../host-screen/host-screen-reply-schema'
import { toNodePlatform } from './mobile-runtime-host-platform'

describe('host platform reads', () => {
  it('keeps a known platform and drops anything else', () => {
    expect(toNodePlatform('linux')).toBe('linux')
    expect(toNodePlatform('win32')).toBe('win32')
    expect(toNodePlatform('beos')).toBeNull()
    expect(toNodePlatform(42)).toBeNull()
  })

  it("reads host.platform's reply into a platform or null", () => {
    expect(hostPlatformSchema.parse({ platform: 'darwin' })).toBe('darwin')
    expect(hostPlatformSchema.parse({ platform: 'beos' })).toBeNull()
    expect(hostPlatformSchema.parse(null)).toBeNull()
  })
})
