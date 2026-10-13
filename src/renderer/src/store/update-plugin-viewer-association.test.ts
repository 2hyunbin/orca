import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGlobalSettingsFixture } from '../../../shared/global-settings-test-fixture'
import { updatePluginViewerAssociation } from './update-plugin-viewer-association'

const { store } = vi.hoisted(() => ({ store: { getState: vi.fn() } }))
vi.mock('@/store', () => ({ useAppStore: store }))
let settings = createGlobalSettingsFixture()
const save = vi.fn(async (update: Partial<typeof settings>) => {
  settings = { ...settings, ...update }
})
beforeEach(() => {
  settings = createGlobalSettingsFixture({ pluginViewerAssociations: [] })
  save.mockClear()
  store.getState.mockImplementation(() => ({ settings, updateSettingsOrThrow: save }))
})
afterEach(async () => {
  await Promise.resolve()
})

describe('serialized viewer preference writes', () => {
  it('preserves defaults saved concurrently from separate panes', async () => {
    await Promise.all([
      updatePluginViewerAssociation({ kind: 'extension', value: '.one' }, 'core'),
      updatePluginViewerAssociation(
        { kind: 'extension', value: '.two' },
        'viewer:community.viewer/two'
      )
    ])
    expect(settings.pluginViewerAssociations).toEqual([
      { selector: { kind: 'extension', value: '.two' }, viewerKey: 'viewer:community.viewer/two' },
      { selector: { kind: 'extension', value: '.one' }, viewerKey: 'core' }
    ])
  })
  it('retains the old preference on failure and lets subsequent saves proceed', async () => {
    settings.pluginViewerAssociations = [
      { selector: { kind: 'extension', value: '.one' }, viewerKey: 'core' }
    ]
    save.mockRejectedValueOnce(new Error('disk unavailable'))
    await expect(
      updatePluginViewerAssociation({ kind: 'extension', value: '.one' }, 'auto')
    ).rejects.toThrow('disk unavailable')
    expect(settings.pluginViewerAssociations).toHaveLength(1)
    await updatePluginViewerAssociation({ kind: 'extension', value: '.two' }, 'core')
    expect(settings.pluginViewerAssociations).toHaveLength(2)
  })
  it('does not persist a queued request canceled when its source pane closes', async () => {
    const controller = new AbortController()
    const result = updatePluginViewerAssociation(
      { kind: 'extension', value: '.one' },
      'core',
      controller.signal
    )
    controller.abort()
    await expect(result).rejects.toThrow('source closed')
    expect(save).not.toHaveBeenCalled()
  })
  it('captures a validated selector before yielding to asynchronous settings persistence', async () => {
    const selector = { kind: 'extension' as const, value: '.one' }
    const result = updatePluginViewerAssociation(selector, 'core')
    selector.value = '.two'
    await result
    expect(settings.pluginViewerAssociations?.[0]?.selector.value).toBe('.one')
  })
})
