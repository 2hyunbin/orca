import type { PluginViewerWorkerSdk } from '@orca/plugin-sdk/viewer'

declare const orcaViewer: PluginViewerWorkerSdk
let lines: string[] = []

orcaViewer.register({
  async open(document) {
    const bytes = document.size
      ? await orcaViewer.readBytes(0, Math.min(document.size, 64))
      : new Uint8Array()
    lines = [
      document.name,
      `${document.size} bytes`,
      [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join(' ')
    ]
    return { kind: 'text', lineCount: lines.length }
  },
  render(viewport) {
    if (viewport.kind !== 'text') {
      throw new Error('Unsupported viewport')
    }
    return {
      kind: 'text',
      startLine: viewport.startLine,
      lines: lines.slice(viewport.startLine, viewport.startLine + viewport.lineCount)
    }
  }
})
