import { describe, expect, it } from 'vitest'
import { createPluginViewerWorkerBootstrap } from './plugin-viewer-worker-bootstrap'

describe('offline viewer worker bootstrap', () => {
  it.each([
    'https://remote.invalid/script.js',
    'blob:https://app.invalid/id',
    'file:///script.js',
    'blob:null/123"; self.postMessage(1); //'
  ])('rejects non-opaque or injectable script URLs: %s', (url) => {
    expect(() => createPluginViewerWorkerBootstrap(url)).toThrow('opaque-origin blob')
  })
})
