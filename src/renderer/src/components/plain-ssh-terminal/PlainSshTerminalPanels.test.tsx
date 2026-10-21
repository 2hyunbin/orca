// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshManagedServerStatus } from '../../../../shared/ssh-types'
import type {
  PlainSshTerminalEvent,
  PlainSshTerminalOpenResult
} from '../../../../shared/plain-ssh-terminal'
import { OpenPlainSshTerminalButton } from './OpenPlainSshTerminalButton'
import { PlainSshTerminalPanels } from './PlainSshTerminalPanels'
import { removePlainSshPanel } from '@/ssh/plain-ssh-terminal-panels'
import { TooltipProvider } from '@/components/ui/tooltip'

const written: string[] = []

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    loadAddon(): void {}
    open(): void {}
    focus(): void {}
    dispose(): void {}
    write(data: string): void {
      written.push(data)
    }
    onData(): { dispose: () => void } {
      return { dispose: () => {} }
    }
    onResize(): { dispose: () => void } {
      return { dispose: () => {} }
    }
  }
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
  }
}))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))
// Shared with the dashboard preview terminal and covered there.
vi.mock('@/components/dashboard-popout/preview-terminal-key-handler', () => ({
  installPreviewTerminalKeyHandler: () => () => {}
}))
vi.mock('@/components/dashboard-popout/preview-terminal-app-menu-clipboard', () => ({
  installPreviewTerminalAppMenuClipboard: () => () => {}
}))
vi.mock('@/components/dashboard-popout/preview-terminal-compatibility', () => ({
  installPreviewTerminalCompatibility: () => () => {}
}))

const blocked: SshManagedServerStatus = {
  kind: 'relay',
  reason: 'refused',
  detail: 'This SSH host cannot move yet: automations (2).'
}

let emit: (event: PlainSshTerminalEvent) => void = () => {}
const open = vi.fn<(args: unknown) => Promise<PlainSshTerminalOpenResult>>()
const close = vi.fn()

beforeEach(() => {
  written.length = 0
  open.mockReset()
  close.mockReset()
  Object.defineProperty(window, 'ResizeObserver', {
    configurable: true,
    value: class {
      observe(): void {}
      disconnect(): void {}
    }
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      plainSsh: {
        open,
        close,
        write: vi.fn(),
        resize: vi.fn(),
        onEvent: (callback: (event: PlainSshTerminalEvent) => void) => {
          emit = callback
          return () => {}
        }
      }
    }
  })
})

afterEach(() => {
  act(() => removePlainSshPanel('lambda'))
  cleanup()
})

function Harness({ status }: { status: SshManagedServerStatus | undefined }): React.JSX.Element {
  return (
    <TooltipProvider>
      <OpenPlainSshTerminalButton targetId="lambda" targetLabel="lambda" status={status} />
      <PlainSshTerminalPanels />
    </TooltipProvider>
  )
}

describe('plain SSH terminal', () => {
  it('is offered only while the host’s move is blocked, and only for this desktop’s host', () => {
    const { rerender } = render(<Harness status={undefined} />)
    expect(screen.queryByRole('button', { name: 'Open plain SSH terminal' })).toBeNull()
    rerender(<Harness status={{ kind: 'managed', environmentId: 'e' }} />)
    expect(screen.queryByRole('button', { name: 'Open plain SSH terminal' })).toBeNull()
    rerender(<Harness status={{ ...blocked, bridged: true }} />)
    expect(screen.queryByRole('button', { name: 'Open plain SSH terminal' })).toBeNull()
    rerender(
      <OpenPlainSshTerminalButton
        targetId="lambda"
        targetLabel="lambda"
        status={blocked}
        ownerEnvironmentId="env-1"
      />
    )
    expect(screen.queryByRole('button', { name: 'Open plain SSH terminal' })).toBeNull()
  })

  it('opens a labelled unmanaged window, shows early output, and closes when ssh exits cleanly', async () => {
    let resolveOpen: (result: PlainSshTerminalOpenResult) => void = () => {}
    open.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveOpen = resolve
        })
    )
    const user = userEvent.setup()
    render(<Harness status={blocked} />)
    await user.click(screen.getByRole('button', { name: 'Open plain SSH terminal' }))

    expect(screen.getByText('Plain SSH · lambda')).toBeInTheDocument()
    expect(screen.getByText(/Plain SSH — unmanaged\. Not an Orca workspace/)).toBeInTheDocument()
    expect(open).toHaveBeenCalledWith({ targetId: 'lambda', cols: 80, rows: 24 })

    // ssh can print before the open reply arrives.
    act(() => emit({ kind: 'data', sessionId: 's1', data: 'Enter passphrase: ' }))
    await act(async () => resolveOpen({ ok: true, sessionId: 's1', label: 'lambda' }))
    expect(written).toEqual(['Enter passphrase: '])

    act(() => emit({ kind: 'exit', sessionId: 's1', exitCode: 0 }))
    await waitFor(() => expect(screen.queryByText('Plain SSH · lambda')).toBeNull())
  })

  it('keeps output when ssh is killed by a signal, even with exit code 0', async () => {
    open.mockResolvedValue({ ok: true, sessionId: 's4', label: 'lambda' })
    const user = userEvent.setup()
    render(<Harness status={blocked} />)
    await user.click(screen.getByRole('button', { name: 'Open plain SSH terminal' }))
    await waitFor(() => expect(open).toHaveBeenCalled())
    await act(async () => {})
    act(() => emit({ kind: 'exit', sessionId: 's4', exitCode: 0, signal: 9 }))
    expect(await screen.findByText(/ssh was stopped \(signal 9\)/)).toBeInTheDocument()
  })

  it('keeps a failed login readable, with no shell to fall back to', async () => {
    open.mockResolvedValue({ ok: true, sessionId: 's2', label: 'lambda' })
    const user = userEvent.setup()
    render(<Harness status={blocked} />)
    await user.click(screen.getByRole('button', { name: 'Open plain SSH terminal' }))
    await waitFor(() => expect(open).toHaveBeenCalled())
    await act(async () => {})
    act(() => emit({ kind: 'exit', sessionId: 's2', exitCode: 255 }))
    expect(await screen.findByText(/ssh exited with code 255/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Close and end session' }))
    expect(screen.queryByText('Plain SSH · lambda')).toBeNull()
  })

  it('shows why it can’t open, e.g. no OpenSSH on Windows', async () => {
    open.mockResolvedValue({
      ok: false,
      reason: 'ssh-missing',
      message: 'Orca couldn’t find OpenSSH (ssh.exe) on this computer.'
    })
    const user = userEvent.setup()
    render(<Harness status={blocked} />)
    await user.click(screen.getByRole('button', { name: 'Open plain SSH terminal' }))
    expect(await screen.findByText(/couldn’t find OpenSSH/)).toBeInTheDocument()
  })

  it('hangs up when its window closes', async () => {
    open.mockResolvedValue({ ok: true, sessionId: 's3', label: 'lambda' })
    const user = userEvent.setup()
    render(<Harness status={blocked} />)
    await user.click(screen.getByRole('button', { name: 'Open plain SSH terminal' }))
    await waitFor(() => expect(open).toHaveBeenCalled())
    await act(async () => {})
    await user.click(screen.getByRole('button', { name: 'Close and end session' }))
    expect(close).toHaveBeenCalledWith({ sessionId: 's3' })
  })
})
