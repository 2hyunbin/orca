import { describe, expect, it } from 'vitest'
import { supportsPromisorGeometricRepack } from './repo-object-maintenance-policy'

describe('promisor-aware geometric repack support', () => {
  it('starts at Git 2.53, including vendor builds', () => {
    expect(supportsPromisorGeometricRepack('git version 2.53.0\n')).toBe(true)
    expect(supportsPromisorGeometricRepack('git version 2.55.0.windows.1')).toBe(true)
    expect(supportsPromisorGeometricRepack('git version 2.52.9')).toBe(false)
    expect(supportsPromisorGeometricRepack('git version 2.39.5 (Apple Git-154)')).toBe(false)
    expect(supportsPromisorGeometricRepack('')).toBe(false)
  })
})
