import type { editor, ISelection } from 'monaco-editor'

type DiffSideSnapshot = {
  uri: string | null
  valueLength: number
  valueTail: string
  selection: ISelection | null
  scrollTop: number
  canUndo: boolean
}

export type MonacoDiffE2EProbe = {
  modelKey: string
  snapshot: () => { original: DiffSideSnapshot; modified: DiffSideSnapshot }
}

function sideSnapshot(side: editor.ICodeEditor): DiffSideSnapshot {
  const model = side.getModel()
  const lastLine = model?.getLineCount() ?? 1
  const tail = model?.getLineContent(lastLine) ?? ''
  return {
    uri: model?.uri.toString() ?? null,
    valueLength: model?.getValueLength() ?? 0,
    valueTail: (tail || model?.getLineContent(Math.max(1, lastLine - 1)) || '').slice(-256),
    selection: side.getSelection(),
    scrollTop: side.getScrollTop(),
    canUndo: model?.canUndo() ?? false
  }
}

export function installMonacoDiffE2EProbe(
  diff: editor.IStandaloneDiffEditor,
  modelKey: string
): () => void {
  if (import.meta.env.MODE !== 'e2e') {
    return () => {}
  }
  const probe: MonacoDiffE2EProbe = {
    modelKey,
    snapshot: () => ({
      original: sideSnapshot(diff.getOriginalEditor()),
      modified: sideSnapshot(diff.getModifiedEditor())
    })
  }
  window.__monacoDiffE2E = probe
  return () => {
    if (window.__monacoDiffE2E === probe) {
      delete window.__monacoDiffE2E
    }
  }
}
