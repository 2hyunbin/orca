import { translate } from '@/i18n/i18n'
import { serializeIpynbDocument } from './ipynb-cell-mutations'
import type { IpynbDocument } from './ipynb-parse'

export function serializeNotebookDraft(document: IpynbDocument): string {
  try {
    return serializeIpynbDocument(document)
  } catch (error) {
    if (error instanceof RangeError) {
      throw new Error(
        translate(
          'auto.components.editor.IpynbViewer.tooLargeToSave',
          'This notebook is too large to save.'
        )
      )
    }
    throw error
  }
}
