// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useMobileEmulatorAgentSetupState } from './use-mobile-emulator-agent-setup-state'
import { MobileEmulatorAgentSetupGuideSteps } from './MobileEmulatorAgentSetupGuideSteps'

const mocks = vi.hoisted(() => ({
  target: { kind: 'environment', environmentId: 'emulator-host' } as const,
  discover: vi.fn(),
  panel: vi.fn()
}))

vi.mock('@/hooks/use-active-skill-discovery-runtime-target', () => ({
  useActiveSkillDiscoveryRuntimeTarget: () => mocks.target
}))
vi.mock('@/hooks/useInstalledAgentSkills', () => ({
  GLOBAL_AGENT_SKILL_SOURCE_KINDS: ['home'],
  useInstalledAgentSkill: mocks.discover
}))
vi.mock('../settings/AgentSkillSetupPanel', () => ({
  AgentSkillSetupPanel: (props: unknown) => {
    mocks.panel(props)
    return null
  }
}))

function EmulatorSetup(): React.JSX.Element {
  const setup = useMobileEmulatorAgentSetupState()
  return <MobileEmulatorAgentSetupGuideSteps setup={setup} />
}

afterEach(cleanup)

describe('mobile emulator skill target', () => {
  it('uses the same host for presence, re-check and installation', () => {
    mocks.discover.mockReturnValue({
      installed: false,
      loading: false,
      error: null,
      refresh: vi.fn(async () => false)
    })
    render(<EmulatorSetup />)
    expect(mocks.discover).toHaveBeenCalledWith(
      'orca-cli',
      expect.objectContaining({
        runtimeTarget: mocks.target
      })
    )
    expect(mocks.panel).toHaveBeenCalledWith(expect.objectContaining({ target: mocks.target }))
  })
})
