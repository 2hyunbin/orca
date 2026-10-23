// @vitest-environment happy-dom
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import type { editor } from 'monaco-editor'
import { expect, it } from 'vitest'
import { syncContentOnMount, syncContentUpdate } from './monaco-content-sync'

it('reconciles unchanged and appended large CRLF text without allocating a normalized copy', () => {
  if (!globalThis.gc) {
    throw new Error('This regression requires the test runner to enable --expose-gc')
  }
  const content = 'row\r\n'.repeat(3_000_000)
  const model = monaco.editor.createModel(content, 'plaintext')
  try {
    expect(model.getEOL()).toBe('\r\n')
    expect(model.getLineCount()).toBe(3_000_001)
    expect(model.getValue()).toBe(content)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: unchanged and read-only sync read only getModel; edits reach the real model.
    const editorInstance = { getModel: () => model } as editor.IStandaloneCodeEditor
    for (const sync of [syncContentOnMount, syncContentUpdate]) {
      globalThis.gc()
      globalThis.gc()
      const before = process.memoryUsage().heapUsed
      sync(editorInstance, content)
      const allocatedBytes = process.memoryUsage().heapUsed - before

      expect(allocatedBytes).toBeLessThan(64 * 1024 * 1024)
      expect(model.getValue()).toBe(content)
      expect(model.canUndo()).toBe(false)
    }
    const appendedContent = `${content}external row\r\n`
    globalThis.gc()
    globalThis.gc()
    const before = process.memoryUsage().heapUsed
    syncContentUpdate(editorInstance, appendedContent, 'read-only-live-tail')
    const allocatedBytes = process.memoryUsage().heapUsed - before

    expect(allocatedBytes).toBeLessThan(64 * 1024 * 1024)
    expect(model.getValue()).toBe(appendedContent)
    expect(model.getLineCount()).toBe(3_000_002)
    expect(model.canUndo()).toBe(false)
  } finally {
    model.dispose()
  }
})
