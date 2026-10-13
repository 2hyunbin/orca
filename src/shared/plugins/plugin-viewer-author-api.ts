export const fileViewerProtocolVersion = 1

export type PluginViewerDocument = {
  name: string
  size: number
  revision: string
  mimeHint?: string
  features: { rangeRead: boolean; watch: boolean }
}

export type PluginViewerSheet = {
  id: string
  label: string
  rowCount: number
  columnCount: number
}

export type PluginViewerSurface =
  | { kind: 'text'; lineCount: number }
  | { kind: 'table'; sheets: PluginViewerSheet[] }
  | { kind: 'canvas'; width: number; height: number }

export type PluginViewerCamera = { yaw: number; pitch: number; zoom: number }
export type PluginViewerViewport =
  | { kind: 'text'; startLine: number; lineCount: number }
  | {
      kind: 'table'
      sheetId: string
      startRow: number
      startColumn: number
      rowCount: number
      columnCount: number
    }
  | { kind: 'canvas'; width: number; height: number; camera: PluginViewerCamera }

export type PluginViewerCell = {
  row: number
  column: number
  text: string
  kind: 'value' | 'cached-formula'
}
export type PluginViewerView =
  | { kind: 'text'; startLine: number; lines: string[] }
  | { kind: 'table'; sheetId: string; cells: PluginViewerCell[] }
  | { kind: 'canvas'; width: number; height: number; pixels: Uint8ClampedArray }

export type PluginViewerAdapter = {
  open(document: Readonly<PluginViewerDocument>): PluginViewerSurface | Promise<PluginViewerSurface>
  render(viewport: Readonly<PluginViewerViewport>): PluginViewerView | Promise<PluginViewerView>
}

export type PluginViewerWorkerSdk = {
  register(adapter: PluginViewerAdapter): void
  readBytes(position: number, length: number): Promise<Uint8Array>
}
