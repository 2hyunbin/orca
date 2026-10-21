// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { useAppStore } from '../../store'
import { AgentsPane } from './AgentsPane'
import { persist } from './settings-persistence-test-fixture'
import { TooltipProvider } from '../ui/tooltip'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }))
vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: () => ({
    detectedIds: ['claude', 'gemini'],
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
  fireEvent.click(within(row).getByRole('button', { name: 'Expand agent settings' }))
  const input = within(row).getByPlaceholderText('No default arguments')
  if (!(input instanceof HTMLInputElement)) {
    throw new Error('Missing Arguments input')
  }
  return input
}

it('retains failed conversion through the ordinary callback and announces only the saved retry', async () => {
  persist.mockRejectedValueOnce(new Error('Settings disk is unavailable'))
  render(<AgentsHarness />)
  const input = argumentsInput('Claude')
  fireEvent.change(input, { target: { value: '--permission-mode auto --model opus' } })
  fireEvent.blur(input)
  await waitFor(() => expect(persist).toHaveBeenCalledTimes(1))
  await waitFor(() => expect(input.readOnly).toBe(false))
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
