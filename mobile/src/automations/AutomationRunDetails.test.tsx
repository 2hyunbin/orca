import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AutomationRunDetails } from './AutomationRunDetails'
import { AutomationButton } from './AutomationControls'
import { automationClient, deferred, savedRun } from './automation-test-fixtures'

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  TextInput: 'TextInput',
  StyleSheet: { create: <T,>(styles: T) => styles }
}))
vi.mock('../components/PickerModal', () => ({ PickerModal: 'PickerModal' }))
vi.mock('../navigation/route-handoff', () => ({
  useRouteHandoff: () => ({ push: inventory.push })
}))
const inventory = vi.hoisted(() => ({ push: vi.fn() }))
let tree: ReactTestRenderer | null = null
afterEach(() => {
  act(() => tree?.unmount())
  tree = null
  inventory.push.mockClear()
})
function root() {
  if (!tree) {
    throw new Error('Not mounted')
  }
  return tree.root
}
async function press(label: string) {
  const button = root()
    .findAllByType(AutomationButton)
    .find((node) => node.props.label === label)
  if (!button || button.props.disabled) {
    throw new Error(`Button unavailable: ${label}`)
  }
  await act(async () => {
    button.props.onPress()
  })
}

describe('exact automation run pane navigation', () => {
  it.each(['success', 'error'] as const)(
    'ignores a superseded pane verification %s while the new authority is opening',
    async (late) => {
      const leaf = '11111111-1111-4111-8111-111111111111'
      const run = {
        ...savedRun(),
        workspaceId: 'folder:saved',
        terminalPaneKey: `original:${leaf}`,
        terminalPtyId: 'pty'
      }
      const a = deferred<unknown>()
      const b = deferred<unknown>()
      const first = automationClient(() => a.promise)
      const second = automationClient(() => b.promise)
      const history = {
        runs: [run],
        selected: run,
        unavailable: false,
        cursor: null,
        loading: false,
        error: null,
        loadMore: vi.fn(),
        reload: vi.fn()
      }
      const props = {
        run,
        client: first.client,
        hostId: 'A',
        connected: true,
        history,
        onBack: vi.fn()
      }
      await act(async () => {
        tree = create(createElement(AutomationRunDetails, props))
      })
      await press('Open agent')
      await act(async () => {
        tree?.update(
          createElement(AutomationRunDetails, { ...props, client: second.client, hostId: 'B' })
        )
      })
      await press('Open agent')
      const reply = {
        terminals: [
          {
            worktreeId: run.workspaceId,
            tabId: 'original',
            leafId: leaf,
            ptyId: 'pty',
            connected: true
          }
        ]
      }
      await act(async () => {
        if (late === 'error') {
          a.reject(new Error('late A'))
        } else {
          a.resolve(reply)
        }
      })
      expect(inventory.push).not.toHaveBeenCalled()
      expect(
        root()
          .findAllByType(AutomationButton)
          .find((node) => node.props.label === 'Open agent')!.props.disabled
      ).toBe(true)
      expect(
        root().findAll(
          (node) => String(node.type) === 'Text' && node.props.accessibilityRole === 'alert'
        )
      ).toHaveLength(0)
      await act(async () => {
        b.resolve(reply)
      })
      expect(inventory.push).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          params: expect.objectContaining({ hostId: 'B', paneKey: run.terminalPaneKey })
        })
      )
    }
  )
})
