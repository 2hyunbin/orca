import { expect, it, vi } from 'vitest'
import { getHostAppVersion } from './host-app-version'

const environment = vi.hoisted(() => ({ getVersion: () => '0.1.0+artifact' }))
vi.mock('./app-environment', () => ({ getAppEnvironment: () => environment }))

it('preserves desktop version lookup when no separate app version is supplied', () => {
  expect(getHostAppVersion()).toBe('0.1.0+artifact')
})

it('uses the compiled app compatibility version separately from a server artifact', () => {
  Object.defineProperty(environment, 'getAppVersion', {
    configurable: true,
    value: () => '1.5.0'
  })
  try {
    expect(getHostAppVersion()).toBe('1.5.0')
  } finally {
    Reflect.deleteProperty(environment, 'getAppVersion')
  }
})
