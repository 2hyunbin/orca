// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useBundledSkillInstall, type BundledSkillInstall } from './use-bundled-skill-install'

type MockRuntimeTarget = { kind: 'local' } | null

const mocks = vi.hoisted(() => {
  const localRuntimeTarget = (): MockRuntimeTarget => ({ kind: 'local' })
  return { install: vi.fn(), runtimeTarget: localRuntimeTarget() }
})

vi.mock('@/runtime/runtime-skills-client', () => ({
  installBundledOrcaSkillsOnRuntimeTarget: mocks.install
}))

vi.mock('./use-active-skill-discovery-runtime-target', () => ({
  useActiveSkillDiscoveryRuntimeTarget: () => mocks.runtimeTarget
}))

let root: Root | null = null
let latest: BundledSkillInstall | null = null

function Harness(): null {
  latest = useBundledSkillInstall({})
  return null
}

async function renderHarness(): Promise<BundledSkillInstall> {
  root = createRoot(document.createElement('div'))
  await act(async () => {
    root?.render(<Harness />)
  })
  if (!latest) {
    throw new Error('hook did not render')
  }
  return latest
}

describe('useBundledSkillInstall', () => {
  beforeEach(() => {
    mocks.install.mockReset()
    mocks.install.mockResolvedValue({ kind: 'installed', results: [] })
    mocks.runtimeTarget = { kind: 'local' }
  })

  afterEach(async () => {
    await act(async () => {
      root?.unmount()
    })
    root = null
    latest = null
  })

  it('reports a failure instead of doing nothing while the agent machine is unknown', async () => {
    mocks.runtimeTarget = null
    const hook = await renderHarness()

    let outcome: Awaited<ReturnType<BundledSkillInstall['install']>> = null
    await act(async () => {
      outcome = await hook.install(['orca-cli'])
    })

    expect(outcome).toEqual({
      kind: 'failed',
      message: 'Orca is still finding the machine your agents run on. Retry in a moment.'
    })
    expect(latest?.state.kind).toBe('failed')
    expect(mocks.install).not.toHaveBeenCalled()
  })

  it('retries the last requested skills', async () => {
    mocks.install.mockRejectedValueOnce(new Error('skill-install-busy'))
    const hook = await renderHarness()

    await act(async () => {
      await hook.install(['orca-cli', 'orchestration'])
    })
    expect(latest?.state.kind).toBe('failed')

    await act(async () => {
      latest?.retry()
    })

    expect(mocks.install).toHaveBeenLastCalledWith(
      { kind: 'local' },
      { names: ['orca-cli', 'orchestration'] }
    )
    expect(latest?.state.kind).toBe('idle')
  })
})
