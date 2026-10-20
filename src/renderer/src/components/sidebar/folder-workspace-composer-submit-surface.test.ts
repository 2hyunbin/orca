// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import type * as LocalRuntimeCapabilitiesModule from '@/runtime/local-runtime-capabilities'
import { makeProjectGroup, makeFolderWorkspace } from './folder-workspace-composer-submit-fixtures'

const mocks = vi.hoisted(() => ({
  activateAndRevealFolderWorkspace: vi.fn(),
  beginStructuredAgentSessionProvisionalLaunch: vi.fn()
}))

vi.mock('@/lib/worktree-activation', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  activateAndRevealFolderWorkspace: mocks.activateAndRevealFolderWorkspace
}))
vi.mock('@/lib/structured-agent-session-provisional-tab', () => ({
  beginStructuredAgentSessionProvisionalLaunch: mocks.beginStructuredAgentSessionProvisionalLaunch
}))
vi.mock('@/runtime/local-runtime-capabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof LocalRuntimeCapabilitiesModule>()),
  readLocalRuntimeCapabilitiesOrUnknown: () => [
    STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
    STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY
  ]
}))

import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'
import { submitFolderWorkspaceCreate } from './folder-workspace-composer-submit'

afterEach(() => {
  mocks.activateAndRevealFolderWorkspace.mockReset()
  mocks.beginStructuredAgentSessionProvisionalLaunch.mockReset()
})

function create(quickSurface?: 'terminal'): Promise<boolean> {
  return submitFolderWorkspaceCreate({
    projectGroup: makeProjectGroup(),
    name: '',
    lastAutoName: '',
    linkedWorkItem: null,
    note: 'Fix the flaky checkout flow',
    quickAgent: 'claude',
    quickSurface,
    autoRenameBranchFromWork: false,
    agentCmdOverrides: {},
    createFolderWorkspace: vi.fn(async () => makeFolderWorkspace()),
    onOpenChange: vi.fn()
  })
}

describe('submitFolderWorkspaceCreate surface pick', () => {
  it('starts the CLI in a terminal for a terminal pick even when chats are the default', async () => {
    useAppStore.setState({
      settings: { ...getDefaultSettings('/home/test'), experimentalNativeChat: true }
    })
    mocks.activateAndRevealFolderWorkspace.mockReturnValue({ primaryTabId: 'tab-1' })

    await create()
    expect(mocks.beginStructuredAgentSessionProvisionalLaunch).toHaveBeenCalledOnce()
    expect(mocks.beginStructuredAgentSessionProvisionalLaunch.mock.calls[0]?.[0]?.plan).toEqual(
      expect.not.objectContaining({ requestedSurface: expect.anything() })
    )

    await create('terminal')
    expect(mocks.beginStructuredAgentSessionProvisionalLaunch).toHaveBeenCalledOnce()
    const startup = mocks.activateAndRevealFolderWorkspace.mock.calls.at(-1)?.[1]?.startup
    expect(startup?.command).toContain('claude')
    expect(startup?.command).toContain('Fix the flaky checkout flow')
  })
})
