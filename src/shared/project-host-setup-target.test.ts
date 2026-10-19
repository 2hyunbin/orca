import { describe, expect, it } from 'vitest'
import { findProjectHostSetup } from './project-host-setup-target'

const local = { id: 'repo-1', hostId: 'local' as const, repoId: 'repo-1' }
const ssh = { id: 'repo-1', hostId: 'ssh:box' as const, repoId: 'repo-1' }

describe('findProjectHostSetup', () => {
  it('keeps the first match by id when the caller names no host', () => {
    expect(findProjectHostSetup([local, ssh], { setupId: 'repo-1' })).toBe(local)
  })

  it('picks the named twin', () => {
    expect(
      findProjectHostSetup([local, ssh], {
        setupId: 'repo-1',
        hostId: 'ssh:box'
      })
    ).toBe(ssh)
  })

  it('never falls back to a sibling when the named twin is gone', () => {
    expect(findProjectHostSetup([local], { setupId: 'repo-1', hostId: 'ssh:box' })).toBeUndefined()
  })

  it('tolerates a client-minted host stamp on an independent setup, whose id is unique', () => {
    const provisioned = {
      id: 'p::gpu',
      hostId: 'runtime:old-client-id' as const,
      repoId: ''
    }
    expect(
      findProjectHostSetup([provisioned], {
        setupId: 'p::gpu',
        hostId: 'local'
      })
    ).toBe(provisioned)
  })

  it('refuses a wrongly named host for an independent setup', () => {
    const provisioned = { id: 'p::gpu', hostId: 'local' as const, repoId: '' }
    expect(
      findProjectHostSetup([provisioned], { setupId: 'p::gpu', hostId: 'ssh:other' })
    ).toBeUndefined()
  })
})
