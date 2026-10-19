import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import { MANAGED_RUNTIME_INSTALL_RUNTIME_CAPABILITY as INSTALL } from '../../../shared/managed-runtime-install'
import {
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY as CATALOG,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY as CHAT
} from '../../../shared/protocol-version'

const rpc = vi.hoisted(() => ({ call: vi.fn(), subscribe: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: rpc.call }))
vi.mock('@/runtime/runtime-rpc-subscribe', () => ({ subscribeRuntimeRpc: rpc.subscribe }))

import { useAppStore } from '@/store'
import { acquireHostStructuredAgentAvailability } from '@/runtime/host-structured-agent-availability'
import {
  loadHostStructuredAgents,
  resetHostStructuredAgentsForTests
} from '@/runtime/host-structured-agents'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { buildNewTabAgentMenuRows } from './new-tab-agent-menu-rows'
import {
  chosenAgentChatUnlearned,
  pickChosenOrDetectedAgent,
  readChatProgram,
  subscribeChatProgramFacts
} from './host-chat-program'

const CAPS = [CHAT, CATALOG, INSTALL]
const LOCAL = { executionHostId: 'local', hostCapabilities: CAPS }
const WORKSPACE = { kind: 'git-worktree' } as const
const row = (agent: string, managedRuntime?: true) => ({
  agent,
  capabilities: {},
  ...(managedRuntime ? { managedRuntime } : {})
})
const initial = useAppStore.getState()

beforeEach(() => {
  rpc.call.mockResolvedValue({ agents: [row('antigravity', true), row('gemini')] })
  rpc.subscribe.mockResolvedValue({ unsubscribe: () => {} })
  setLocalRuntimeCapabilitiesForTests(CAPS)
  useAppStore.setState({
    settings: { ...getDefaultSettings('/tmp'), experimentalNativeChat: true, defaultTuiAgent: null }
  })
})

afterEach(() => {
  resetHostStructuredAgentsForTests()
  setLocalRuntimeCapabilitiesForTests(null)
  useAppStore.setState(initial, true)
})

// Runs first: the host snapshot the next test publishes outlives it.
it('opens an explicit default as a chat even when CLI detection failed; automatic and blank picks stay on detected agents', async () => {
  const pick = (chosen: 'antigravity' | 'blank' | null, detected: [] | null) =>
    pickChosenOrDetectedAgent(useAppStore.getState(), {
      chosen,
      detected,
      disabled: [],
      workspace: WORKSPACE
    })
  // Cold: the host's agents are not learned yet, so the default waits rather than being passed over.
  expect(chosenAgentChatUnlearned(useAppStore.getState(), 'antigravity', [], WORKSPACE)).toBe(true)
  // What the dashboard and its pop-out republish on: these facts live outside the store.
  const republish = vi.fn()
  const stop = subscribeChatProgramFacts(republish)
  await loadHostStructuredAgents('local', CAPS, null)
  stop()
  expect(republish).toHaveBeenCalled()
  expect(chosenAgentChatUnlearned(useAppStore.getState(), 'antigravity', [], WORKSPACE)).toBe(false)

  expect(pick('antigravity', null)).toBe('antigravity')
  expect(pick(null, [])).toBeNull()
  expect(pick('blank', [])).toBeNull()
  const state = useAppStore.getState()
  // The menu offers that chat with detection failed, and no CLI row or terminal for it.
  expect(
    buildNewTabAgentMenuRows({
      settings: state.settings,
      detectedOnHost: null,
      chatAgents: ['claude', 'antigravity'],
      hostChatAnswer: () => 'yes',
      chatProgram: (agent) => readChatProgram(state, agent, LOCAL, null)
    })
  ).toEqual([
    { kind: 'chat', agent: 'antigravity' },
    { kind: 'chat-unavailable', agent: 'claude', reason: 'check-failed' }
  ])
  // A provider switched off routes to a terminal, which needs the CLI.
  useAppStore.setState({
    settings: {
      ...getDefaultSettings('/tmp'),
      experimentalNativeChat: true,
      nativeChatProviders: { antigravity: false }
    }
  })
  expect(pick('antigravity', [])).toBeNull()
})

it("reads the host's published program first, else that same host's managed mark and install capability, else the CLI", async () => {
  await loadHostStructuredAgents('local', CAPS, null)
  const state = useAppStore.getState()
  expect(readChatProgram(state, 'antigravity', LOCAL, [])).toBe('installable')
  // A host that cannot install keeps the CLI-based offer; another host's mark says nothing.
  expect(readChatProgram(state, 'antigravity', { ...LOCAL, hostCapabilities: [CHAT] }, [])).toBe(
    'missing'
  )
  expect(
    readChatProgram(
      state,
      'antigravity',
      { executionHostId: 'runtime:env', hostCapabilities: CAPS },
      []
    )
  ).toBe('missing')
  expect(readChatProgram(state, 'gemini', LOCAL, ['gemini'])).toBe('available')

  acquireHostStructuredAgentAvailability({
    target: { kind: 'local' },
    executionHostId: 'local',
    runtimeId: null,
    pairingRevision: undefined
  })
  rpc.subscribe.mock.calls[0][3].onEvent({
    type: 'availability',
    agents: [
      { agent: 'antigravity', state: 'available', chatProgram: 'available' },
      // A value this build does not know claims nothing, like a field an older host never sends.
      { agent: 'gemini', state: 'available', chatProgram: 'from-a-newer-host' },
      { agent: 'claude', state: 'available' }
    ]
  })
  expect(readChatProgram(state, 'antigravity', LOCAL, [])).toBe('available')
  expect(readChatProgram(state, 'gemini', LOCAL, [])).toBe('missing')
  expect(readChatProgram(state, 'claude', LOCAL, ['claude'])).toBe('available')
})
