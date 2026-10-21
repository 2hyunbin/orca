import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

/** A delayed view edit was dropped because the shared text changed after the edit began. */
export function notifyStaleViewEditRejected(): void {
  toast.error(
    translate(
      'auto.components.editor.staleViewEdit.rejected',
      "Your last edit in this view couldn't be applied because the file changed elsewhere."
    ),
    { id: 'editor-stale-view-edit' }
  )
}
