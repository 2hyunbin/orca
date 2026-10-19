// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentRowPermissionControl } from './AgentRowPermissionControl'

afterEach(cleanup)

describe('agent row permissions', () => {
  it('names the agent and exposes Auto only when supported', async () => {
    const change = vi.fn()
    const { rerender } = render(
      <AgentRowPermissionControl label="Codex" mode="manual" autoSupported onChange={change} />
    )
    fireEvent.keyDown(screen.getByRole('button', { name: 'Codex permissions' }), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Auto' }))
    expect(change).toHaveBeenCalledWith('auto')
    rerender(
      <AgentRowPermissionControl
        label="Other"
        mode="manual"
        autoSupported={false}
        onChange={change}
      />
    )
    fireEvent.keyDown(screen.getByRole('button', { name: 'Other permissions' }), { key: 'Enter' })
    expect(screen.queryByRole('menuitemradio', { name: 'Auto' })).toBeNull()
  })

  it('reapplies the selected mode to synchronize a different native default', async () => {
    const change = vi.fn()
    render(<AgentRowPermissionControl label="Codex" mode="auto" autoSupported onChange={change} />)
    fireEvent.keyDown(screen.getByRole('button', { name: 'Codex permissions' }), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Auto' }))
    expect(change).toHaveBeenCalledExactlyOnceWith('auto')
  })

  it('shows Custom arguments without offering a destructive preset', () => {
    const change = vi.fn()
    render(<AgentRowPermissionControl label="Codex" mode="mixed" autoSupported onChange={change} />)
    const picker = screen.getByRole('button', { name: 'Codex permissions' })
    expect(picker.textContent).toBe('Custom arguments')
    expect(picker.hasAttribute('disabled')).toBe(true)
    fireEvent.click(picker)
    expect(change).not.toHaveBeenCalled()
  })
})
