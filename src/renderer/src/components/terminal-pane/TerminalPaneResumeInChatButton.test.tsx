// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { CliChatResumeSource } from '../tab-bar/cli-chat-resume-source'
import { TerminalPaneResumeInChatButton } from './TerminalPaneResumeInChatButton'

const mocks = vi.hoisted(() => {
  const source: CliChatResumeSource = {
    tabId: 'tab-1',
    workspaceId: 'wt-1',
    paneKey: 'tab-1:leaf',
    agent: 'claude',
    providerSessionId: 'provider-1',
    executionHostId: 'local',
    ptyId: 'pty-1'
  }
  return { source, resolve: vi.fn(), run: vi.fn(), pending: false, running: true }
})
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      paneForegroundAgentByPaneKey: {},
      agentStatusByPaneKey: mocks.running ? { 'tab-1:leaf': 'working' } : {}
    })
}))
vi.mock('../tab-bar/cli-chat-resume-source', () => ({
  useCliChatResumeCapability: (_worktreeId: string, agent: string) => agent === 'codex',
  resolveCliChatResumeSource: (_state: unknown, args: unknown) => {
    mocks.resolve(args)
    return mocks.source
  }
}))
vi.mock('../tab-bar/cli-chat-resume-run', () => ({
  runCliChatResume: mocks.run,
  useCliChatResumePending: () => mocks.pending
}))
afterEach(cleanup)
beforeEach(() => {
  mocks.source.agent = 'claude'
  mocks.pending = false
  mocks.running = true
  vi.clearAllMocks()
})

it.each([
  ['claude', 'Resume in New Chat'],
  ['codex', 'Switch to native chat']
] as const)('offers the %s action for the exact pane and shares pending', (agent, label) => {
  mocks.source.agent = agent
  mocks.running = agent === 'claude'
  const { rerender } = render(
    <TooltipProvider>
      <TerminalPaneResumeInChatButton tabId="tab-1" worktreeId="wt-1" paneKey="tab-1:leaf" />
    </TooltipProvider>
  )
  fireEvent.click(screen.getByRole('button', { name: label }))
  expect(mocks.resolve).toHaveBeenCalledWith({
    tab: { id: 'tab-1', worktreeId: 'wt-1' },
    paneKey: 'tab-1:leaf'
  })
  expect(mocks.run).toHaveBeenCalledWith(mocks.source)
  mocks.pending = true
  rerender(
    <TooltipProvider>
      <TerminalPaneResumeInChatButton tabId="tab-1" worktreeId="wt-1" paneKey="tab-1:leaf" />
    </TooltipProvider>
  )
  expect(screen.getByRole('button').getAttribute('aria-busy')).toBe('true')
  expect(screen.getByRole('button').hasAttribute('disabled')).toBe(true)
})
