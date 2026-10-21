// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { useAppStore } from '../../store'
import { AgentsPane } from './AgentsPane'
import { persist } from './settings-persistence-test-fixture'
import { TooltipProvider } from '../ui/tooltip'
import { resolveTuiAgentLaunchArgs } from '../../../../shared/tui-agent-launch-defaults'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }))
vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: () => ({
    detectedIds: ['claude', 'gemini', 'goose'],
    detectionFailed: false,
    isRefreshing: false,
    refresh: vi.fn()
  })
}))
vi.mock('./AgentAwakeSetting', () => ({ AgentAwakeSetting: () => null }))
vi.mock('./AgentCacheTimerSection', () => ({ AgentCacheTimerSection: () => null }))

beforeEach(() => {
  Object.assign(window.api, { platform: { get: () => ({ platform: 'darwin' }) } })
  const settings = useAppStore.getState().settings
  if (!settings) {
    throw new Error('Missing settings fixture')
  }
  useAppStore.setState({ settings: { ...settings, agentPermissionDefault: 'ask' } })
})

function AgentsHarness() {
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  if (!settings) {
    throw new Error('Missing settings fixture')
  }
  return (
    <TooltipProvider>
      <AgentsPane
        settings={settings}
        updateSettings={updateSettings}
        hostScope={{ target: { kind: 'local' }, available: true }}
      />
    </TooltipProvider>
  )
}

function argumentsInput(label: string): HTMLInputElement {
  const row = screen.getByText(label, { selector: 'span' }).closest('div.py-3')
  if (!(row instanceof HTMLElement)) {
    throw new Error('Missing agent row')
  }
  const expand = within(row).queryByRole('button', { name: 'Expand agent settings' })
  if (expand) {
    fireEvent.click(expand)
  }
  const input = within(row).getByPlaceholderText('No default arguments')
  if (!(input instanceof HTMLInputElement)) {
    throw new Error('Missing Arguments input')
  }
  return input
}

it.each([
  '--model opus --dangerously-skip-permissions',
  '--dangerously-skip-permissions --model opus'
])('retires the acknowledged recipe %s before chip removal and neutral events', async (recipe) => {
  savedArguments('--model opus', 'full-access')
  render(<AgentsHarness />)
  const input = argumentsInput('Claude')
  const remove = () =>
    screen.getByRole('button', { name: /Remove .* and use Claude's own settings/ })
  fireEvent.click(remove())
  await waitFor(() => expect(persist).toHaveBeenCalledTimes(1))
  const user = userEvent.setup()
  await user.click(input)
  await user.clear(input)
  await user.type(input, recipe)
  await user.keyboard('{Enter}')
  await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1))
  expect(persist).toHaveBeenCalledTimes(2)
  expect(useAppStore.getState().settings?.agentPermissionOverrides?.claude).toBe('full-access')
  expect(resolveTuiAgentLaunchArgs('claude', useAppStore.getState().settings ?? {})).toBe(
    '--dangerously-skip-permissions --model opus'
  )
  expect(input.value).toBe('--model opus')
  fireEvent.click(remove())
  await waitFor(() => expect(persist).toHaveBeenCalledTimes(3))
  await user.click(input)
  await user.tab()
  await user.click(input)
  await user.keyboard('{Enter}')
  expect(persist).toHaveBeenCalledTimes(3)
  expect(toast.success).toHaveBeenCalledTimes(1)
  expect(useAppStore.getState().settings?.agentPermissionOverrides?.claude).toBe('own')
  await user.click(input)
  await user.type(input, ' --dangerously-skip-permissions')
  await user.keyboard('{Escape}')
  expect(input.value).toBe('--model opus')
  await user.tab()
  fireEvent.change(input, { target: { value: '  --model opus  ' } })
  fireEvent.blur(input)
  expect(input.value).toBe('--model opus')
  expect(persist).toHaveBeenCalledTimes(3)
})

it('retains failed conversion through the ordinary callback and announces only the saved retry', async () => {
  savedArguments('--model opus')
  const save = deferredSave()
  render(<AgentsHarness />)
  const input = argumentsInput('Claude')
  fireEvent.change(input, { target: { value: '--permission-mode auto --model opus' } })
  fireEvent.blur(input)
  await waitFor(() => expect(persist).toHaveBeenCalledTimes(1))
  act(() => savedArguments(''))
  expect(input.isConnected).toBe(true)
  await act(async () => save.reject(new Error('Settings disk is unavailable')))
  await waitFor(() => expect(input.readOnly).toBe(false))
  expect(toast.error).toHaveBeenCalledExactlyOnceWith(
    'Claude settings could not be saved. Try again.'
  )
  expect(toast.success).not.toHaveBeenCalled()
  expect(useAppStore.getState().settings?.agentPermissionDefault).toBe('ask')
  expect(useAppStore.getState().settings?.agentPermissionOverrides?.claude).toBeUndefined()
  expect(input.value).toBe('--permission-mode auto --model opus')
  fireEvent.blur(input)
  await waitFor(() =>
    expect(toast.success).toHaveBeenCalledWith(
      'Claude set to Approve for me in terminals and new chats.'
    )
  )
  expect(useAppStore.getState().settings?.agentPermissionOverrides?.claude).toBe('auto')
  expect(useAppStore.getState().settings?.agentDefaultArgs?.claude).toBe('--model opus')
  await waitFor(() => expect(input.value).toBe('--model opus'))
  act(() => savedArguments('--later'))
  expect(input.value).toBe('--later')
  fireEvent.change(input, { target: { value: '--dirty' } })
  act(() => savedArguments(''))
  expect(input.value).toBe('--dirty')
  fireEvent.keyDown(input, { key: 'Escape' })
  expect(input.value).toBe('')
})

it('describes terminal-only conversion without claiming new native chats', async () => {
  render(<AgentsHarness />)
  const input = argumentsInput('Gemini')
  fireEvent.change(input, { target: { value: '--yolo' } })
  fireEvent.blur(input)
  await waitFor(() =>
    expect(toast.success).toHaveBeenCalledWith('Gemini set to Full access in terminals.')
  )
  expect(useAppStore.getState().settings?.agentPermissionOverrides?.gemini).toBe('full-access')
  expect(useAppStore.getState().settings?.agentDefaultArgs?.gemini).toBe('')
})

function savedArguments(value: string, choice: 'ask' | 'full-access' = 'ask') {
  useAppStore.setState(({ settings }) => ({
    settings: settings && {
      ...settings,
      agentPermissionDefault: choice,
      agentDefaultArgs: { claude: value }
    }
  }))
}

function savedEnvironment(env: Record<string, string>, agent = 'claude') {
  const settings = useAppStore.getState().settings
  if (!settings) {
    throw new Error('Missing settings fixture')
  }
  useAppStore.setState({
    settings: { ...settings, agentDefaultEnv: { ...settings.agentDefaultEnv, [agent]: env } }
  })
}
function environmentInput(value: string): HTMLInputElement {
  const input = screen.getByDisplayValue(value)
  if (!(input instanceof HTMLInputElement)) {
    throw new Error('Missing Environment input')
  }
  return input
}
function deferredSave() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const done = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  persist.mockImplementationOnce(async (updates) => {
    await done
    const settings = useAppStore.getState().settings
    if (!settings) {
      throw new Error('Missing settings fixture')
    }
    return { ...settings, ...updates }
  })
  return { resolve, reject }
}

it('retains a whole failed Environment edit across empty publication and retries once', async () => {
  savedEnvironment({ A: 'old', B: 'old' })
  const save = deferredSave()
  render(<AgentsHarness />)
  const input = environmentInput('A=old B=old')
  fireEvent.change(input, { target: { value: 'A=new B=new' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  fireEvent.blur(input)
  await waitFor(() => expect(persist).toHaveBeenCalledTimes(1))
  expect(persist.mock.calls[0][0].agentDefaultEnv?.claude).toEqual({ A: 'new', B: 'new' })
  act(() => savedEnvironment({}))
  expect(input.isConnected).toBe(true)
  await act(async () => save.reject(new Error('secret provider details')))
  await waitFor(() => expect(input.readOnly).toBe(false))
  expect(input.value).toBe('A=new B=new')
  expect(toast.error).toHaveBeenCalledExactlyOnceWith(
    'Claude settings could not be saved. Try again.'
  )
  expect(toast.success).not.toHaveBeenCalled()
  fireEvent.blur(input)
  await waitFor(() =>
    expect(useAppStore.getState().settings?.agentDefaultEnv?.claude).toEqual({ A: 'new', B: 'new' })
  )
  expect(persist).toHaveBeenCalledTimes(2)
  act(() => savedEnvironment({ A: 'external' }))
  expect(input.value).toBe('A=external')
  const user = userEvent.setup()
  await user.click(input)
  await user.type(input, 'discard')
  await user.keyboard('{Escape}')
  expect(input.value).toBe('A=external')
  fireEvent.blur(input)
  await waitFor(() => expect(input.readOnly).toBe(false))
  expect(persist).toHaveBeenCalledTimes(2)
})

it('orders real blur then Reset, retains pre-Reset work on rejection and resets on acknowledgement', async () => {
  savedEnvironment({ A: 'old' })
  const blur = deferredSave()
  const reset = deferredSave()
  const user = userEvent.setup()
  render(<AgentsHarness />)
  const input = environmentInput('A=old')
  await user.click(input)
  await user.clear(input)
  await user.type(input, 'A=draft')
  const row = input.closest('div.py-3')
  if (!(row instanceof HTMLElement)) {
    throw new Error('Missing row')
  }
  const resetButton = within(row).getByRole('button', { name: 'Reset' })
  await user.click(resetButton)
  await waitFor(() => expect(persist).toHaveBeenCalledTimes(1))
  await act(async () => blur.resolve())
  await waitFor(() => expect(persist).toHaveBeenCalledTimes(2))
  act(() => savedEnvironment({}))
  expect(input.isConnected).toBe(true)
  expect(input.value).toBe('A=draft')
  await act(async () => reset.reject(new Error('offline')))
  await waitFor(() => expect(input.readOnly).toBe(false))
  expect(input.value).toBe('A=draft')
  await user.click(resetButton)
  await waitFor(() => expect(input.isConnected).toBe(false))
  expect(useAppStore.getState().settings?.agentDefaultEnv?.claude).toEqual({})
  expect(toast.error).toHaveBeenCalledTimes(1)
})

it.each(['darwin', 'win32'] as const)(
  'stages host env transforms once on %s and preserves other agents',
  async (platform) => {
    Object.assign(window.api, { platform: { get: () => ({ platform }) } })
    savedEnvironment({ Path: 'old' })
    savedEnvironment({ TOKEN: 'keep' }, 'gemini')
    render(<AgentsHarness />)
    const input = environmentInput('Path=old')
    fireEvent.change(input, { target: { value: 'Path=old PATH=new' } })
    act(() => savedEnvironment({ TOKEN: 'latest' }, 'gemini'))
    expect(input.value).toBe('Path=old PATH=new')
    fireEvent.blur(input)
    await waitFor(() => expect(persist).toHaveBeenCalledTimes(1))
    expect(useAppStore.getState().settings?.agentDefaultEnv).toMatchObject({
      claude: platform === 'win32' ? { PATH: 'new' } : { Path: 'old', PATH: 'new' },
      gemini: { TOKEN: 'latest' }
    })
  }
)

it('imports then removes Goose carrier through one whole edit per acknowledgement', async () => {
  savedEnvironment({ OTHER: 'keep' }, 'goose')
  render(<AgentsHarness />)
  const input = environmentInput('OTHER=keep')
  fireEvent.change(input, { target: { value: 'OTHER=next GOOSE_MODE=auto' } })
  fireEvent.blur(input)
  await waitFor(() =>
    expect(useAppStore.getState().settings?.agentPermissionOverrides?.goose).toBe('full-access')
  )
  expect(useAppStore.getState().settings?.agentDefaultEnv?.goose).toEqual({ OTHER: 'next' })
  fireEvent.change(input, { target: { value: 'OTHER=last' } })
  fireEvent.blur(input)
  await waitFor(() =>
    expect(useAppStore.getState().settings?.agentPermissionOverrides?.goose).toBe('own')
  )
  expect(useAppStore.getState().settings?.agentDefaultEnv?.goose).toEqual({ OTHER: 'last' })
  expect(persist).toHaveBeenCalledTimes(2)
})

it('reports one direct local permission action failure without changing saved intent', async () => {
  persist.mockRejectedValueOnce(new Error('private error'))
  render(<AgentsHarness />)
  fireEvent.click(screen.getByRole('radio', { name: 'Full access' }))
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledExactlyOnceWith(
      'Agent settings could not be saved. Try again.'
    )
  )
  expect(useAppStore.getState().settings?.agentPermissionDefault).toBe('ask')
})
