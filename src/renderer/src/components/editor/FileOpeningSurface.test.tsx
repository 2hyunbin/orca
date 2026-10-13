// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { usePluginFileViewerStore } from '@/store/plugin-file-viewers'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import type { OpenFile } from '@/store/slices/editor'
import { FileOpeningSurface } from './FileOpeningSurface'

vi.mock('./PluginFileViewerPicker', () => ({ PluginFileViewerPicker: () => null }))

const file: OpenFile = {
  id: 'selected',
  filePath: '/host/outside.xlsx',
  relativePath: '/host/outside.xlsx',
  worktreeId: 'remote-folder',
  language: 'plaintext',
  mode: 'file-opening',
  readOnly: true,
  isDirty: false,
  pluginViewerUserSelectedFile: true,
  fileOpeningChoicePending: true
}
let root: Root
let container: HTMLDivElement
async function render(selected: OpenFile = file): Promise<void> {
  await act(async () => root.render(<FileOpeningSurface file={selected} scopeId="pane" />))
}
function button(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label
  )
}

beforeEach(() => {
  useAppStore.setState({
    settings: createGlobalSettingsFixture(),
    activeView: 'terminal',
    previousViewBeforeSettings: 'terminal',
    openFiles: [file],
    pluginCatalogTypeFilter: 'all',
    settingsNavigationTarget: null
  })
  usePluginFileViewerStore.setState({ status: 'ready', viewers: [], syntaxPacks: [] })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('file viewer acquisition and recovery', () => {
  it('opens the viewer catalog and returns to the same read-only source tab', async () => {
    await render()
    expect(container.textContent).toContain('No installed viewer matches this file.')
    expect(button('Use Orca once')).toBeUndefined()
    const browse = button('Browse file viewers')
    expect(browse).toBeDefined()
    await act(async () => browse?.click())
    expect(useAppStore.getState().activeView).toBe('settings')
    expect(useAppStore.getState().settingsNavigationTarget).toEqual({
      pane: 'plugins',
      repoId: null
    })
    expect(useAppStore.getState().pluginCatalogTypeFilter).toBe('file-viewer')
    expect(useAppStore.getState().openFiles).toEqual([file])
    useAppStore.getState().closeSettingsPage()
    expect(useAppStore.getState().activeView).toBe('terminal')
    expect(useAppStore.getState().openFiles).toEqual([file])
  })

  it('does not suggest a core fallback when metadata fails', async () => {
    usePluginFileViewerStore.setState({ status: 'failed' })
    await render()
    expect(container.textContent).toContain('Could not load available viewers. Try again.')
    expect(button('Retry')).toBeDefined()
    expect(button('Browse file viewers')).toBeDefined()
    expect(button('Use Orca once')).toBeUndefined()
  })

  it.each(['loading', 'unsupported'] as const)(
    'does not promise installation for %s metadata',
    async (status) => {
      usePluginFileViewerStore.setState({ status })
      await render()
      expect(button('Browse file viewers')).toBeUndefined()
      expect(container.textContent).toContain(
        status === 'loading'
          ? 'Finding available file viewers…'
          : 'This connection does not support plugin file viewers yet.'
      )
    }
  )

  it('checks metadata availability even for a core-known extension on a selected remote file', async () => {
    usePluginFileViewerStore.setState({ status: 'failed' })
    await render({ ...file, filePath: '/host/outside.pdf' })
    expect(container.textContent).toContain('Could not load available viewers. Try again.')
    expect(container.textContent).not.toContain('No installed viewer')
    expect(button('Use Orca once')).toBeUndefined()
  })

  it('does not mask an unresolved owner with an install suggestion', async () => {
    await render({ ...file, fileOpeningOwnerUnresolved: true })
    expect(container.textContent).toContain('Reopen the file after its connection settles.')
    expect(button('Browse file viewers')).toBeUndefined()
  })

  it('offers catalog recovery for a missing saved viewer without changing the default', async () => {
    useAppStore.setState({
      settings: createGlobalSettingsFixture({
        pluginViewerAssociations: [
          {
            selector: { kind: 'extension', value: '.xlsx' },
            viewerKey: 'viewer:community.missing/xlsx'
          }
        ]
      })
    })
    await render()
    expect(container.textContent).toContain(
      'The saved viewer is disabled, missing, or incompatible'
    )
    expect(button('Browse file viewers')).toBeDefined()
    expect(useAppStore.getState().settings?.pluginViewerAssociations?.[0]?.viewerKey).toBe(
      'viewer:community.missing/xlsx'
    )
  })
})
