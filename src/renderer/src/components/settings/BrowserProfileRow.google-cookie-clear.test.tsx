// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { ConfirmationDialogContext } from '../confirmation-dialog-context'

const mocks = vi.hoisted(() => ({
  target: vi.fn(),
  clear: vi.fn(),
  fetch: vi.fn(),
  confirm: vi.fn()
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/store', () => {
  const state = {
    settings: {},
    browserSessionHostIdOverride: 'local',
    runtimeEnvironments: [],
    fetchDetectedBrowsers: mocks.fetch
  }
  return {
    useAppStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), {
      getState: () => state
    })
  }
})
vi.mock('../BrowserCookieImportMachineNotice', () => ({
  BrowserCookieImportMachineNotice: () => null
}))
vi.mock('../ui/dropdown-menu', () => {
  const passthrough = ({ children }: { children?: ReactNode }) => <>{children}</>
  return {
    DropdownMenu: ({
      children,
      onOpenChange
    }: {
      children: ReactNode
      onOpenChange: (open: boolean) => void
    }) => (
      <div>
        <button onClick={() => onOpenChange(true)}>Open import</button>
        {children}
      </div>
    ),
    DropdownMenuItem: ({
      children,
      onSelect,
      disabled
    }: {
      children: ReactNode
      onSelect: () => void
      disabled?: boolean
    }) => (
      <button disabled={disabled} onClick={onSelect}>
        {children}
      </button>
    ),
    DropdownMenuContent: passthrough,
    DropdownMenuLabel: passthrough,
    DropdownMenuPortal: passthrough,
    DropdownMenuSub: passthrough,
    DropdownMenuSubContent: passthrough,
    DropdownMenuSubTrigger: passthrough,
    DropdownMenuTrigger: passthrough,
    DropdownMenuSeparator: () => <hr />
  }
})
import { BrowserProfileRow } from './BrowserProfileRow'

afterEach(cleanup)

it('offers a repeatable Google-only clear without an import source and confirms before calling main', async () => {
  const target = {
    profileId: 'work',
    environmentId: null,
    partition: 'persist:work',
    routeIdentity: null
  }
  mocks.target.mockResolvedValue(target)
  mocks.clear.mockResolvedValue('cleared')
  mocks.confirm.mockResolvedValueOnce(false).mockResolvedValue(true)
  vi.stubGlobal(
    'window',
    Object.assign(window, {
      api: {
        browser: {
          sessionGoogleCookieClearTarget: mocks.target,
          sessionClearGoogleCookies: mocks.clear
        }
      }
    })
  )
  render(
    <ConfirmationDialogContext.Provider value={mocks.confirm}>
      <BrowserProfileRow
        profile={{
          id: 'work',
          label: 'Work',
          partition: 'persist:work',
          scope: 'isolated',
          source: null
        }}
        detectedBrowsers={[]}
        importState={null}
        isActive
        onSelect={() => {}}
      />
    </ConfirmationDialogContext.Provider>
  )
  fireEvent.click(screen.getByText('Open import'))
  const clear = await screen.findByRole('button', { name: 'Clear Google cookies…' })
  fireEvent.click(clear)
  await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1))
  expect(mocks.clear).not.toHaveBeenCalled()
  await waitFor(() => expect(clear.hasAttribute('disabled')).toBe(false))
  fireEvent.click(clear)
  await waitFor(() => expect(mocks.clear).toHaveBeenCalledWith(target))
  await waitFor(() => expect(clear.hasAttribute('disabled')).toBe(false))
  fireEvent.click(clear)
  await waitFor(() => expect(mocks.clear).toHaveBeenCalledTimes(2))
})
