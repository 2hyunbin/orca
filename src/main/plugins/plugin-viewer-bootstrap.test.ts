import { describe, expect, it, vi } from 'vitest'
import { pluginViewerChromeSchema } from '../../shared/plugins/plugin-viewer-frame-protocol'
vi.mock('electron', () => ({ app: {} }))
import {
  renderPluginViewerBootstrap,
  resolvePluginViewerAssetsDirectory
} from './plugin-viewer-bootstrap'
import { join } from 'node:path'

describe('main-owned viewer bootstrap', () => {
  it('resolves packaged, package-root development and direct-entry development layouts', () => {
    const root = join('application', 'app.asar')
    expect(resolvePluginViewerAssetsDirectory(root, true, () => true)).toBe(
      join(root, 'out', 'main', 'plugin-viewer-assets')
    )
    expect(resolvePluginViewerAssetsDirectory('project', false, () => false)).toBe(
      join('project', 'out', 'main', 'plugin-viewer-assets')
    )
    expect(
      resolvePluginViewerAssetsDirectory(join('project', 'out', 'main'), false, () => true)
    ).toBe(join('project', 'out', 'main', 'plugin-viewer-assets'))
  })
  it('encodes labels and child markup without creating a script injection', () => {
    const labels = {
      loading: 'Loading',
      empty: 'Empty',
      previous: 'Previous',
      next: 'Next',
      sheet: 'Sheet',
      reset: 'Reset',
      cachedFormula: 'Saved',
      failed: 'Failed',
      title: '</script><img src="https://example.invalid">',
      zoomIn: 'In',
      zoomOut: 'Out'
    }
    const chrome = pluginViewerChromeSchema.parse({ dark: true, labels })
    const page = renderPluginViewerBootstrap(chrome, {
      parent: 'parent()',
      frame: 'frame()',
      css: 'body{}'
    })
    expect(page.match(/<script\b/g)).toHaveLength(2)
    expect(page).not.toContain('<img')
    const raw = page.match(/id="viewer-configuration">(.*?)<\/script>/s)?.[1]
    expect(JSON.parse(raw ?? 'null')).toMatchObject({
      chrome,
      frame: expect.stringContaining("frame-src 'none'")
    })
    expect(page).toContain('font-src data:')
  })
})
