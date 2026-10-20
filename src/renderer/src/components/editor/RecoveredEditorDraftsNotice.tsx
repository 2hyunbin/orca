import React, { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { RecoveredEditorDraft } from '../../../../shared/workspace-session-state-types'
import { RecoveredEditorDraftCompareDialog } from './RecoveredEditorDraftCompareDialog'

const TOAST_ID = 'recovered-editor-drafts'

function draftName(draft: RecoveredEditorDraft): string {
  const path = draft.relativePath ?? draft.filePath
  return path.split(/[\\/]/).pop() || path
}

/**
 * Offers back drafts an older session held in a second tab of a file. Shown once per launch
 * while any remain; each stays in the session until dismissed.
 */
export function RecoveredEditorDraftsNotice(): React.JSX.Element {
  const drafts = useAppStore((state) => state.recoveredEditorDrafts)
  const [comparing, setComparing] = useState<RecoveredEditorDraft | null>(null)
  const closedByUserRef = useRef(false)

  useEffect(() => {
    if (drafts.length === 0) {
      toast.dismiss(TOAST_ID)
      return
    }
    if (closedByUserRef.current) {
      return
    }
    toast(
      translate(
        'auto.components.editor.RecoveredEditorDraftsNotice.3c7e0b5d18',
        'Recovered {{value0}} unsaved draft(s) from an earlier session',
        { value0: drafts.length }
      ),
      {
        id: TOAST_ID,
        duration: Infinity,
        onDismiss: () => {
          closedByUserRef.current = true
        },
        description: (
          <div className="mt-1 flex flex-col gap-1">
            {drafts.map((draft) => (
              <div
                key={`${draft.filePath}:${draft.recoveredAt}`}
                className="flex items-center gap-1"
              >
                <span className="min-w-0 flex-1 truncate">{draftName(draft)}</span>
                <Button size="xs" variant="outline" onClick={() => setComparing(draft)}>
                  {translate(
                    'auto.components.editor.RecoveredEditorDraftsNotice.9a51e2f074',
                    'Compare'
                  )}
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => void window.api.ui.writeClipboardText(draft.draft)}
                >
                  {translate(
                    'auto.components.editor.RecoveredEditorDraftsNotice.d40b6a2c95',
                    'Copy'
                  )}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => useAppStore.getState().dismissRecoveredEditorDraft(draft)}
                >
                  {translate(
                    'auto.components.editor.RecoveredEditorDraftsNotice.71fc3e8b2a',
                    'Dismiss'
                  )}
                </Button>
              </div>
            ))}
          </div>
        )
      }
    )
  }, [drafts])

  return (
    <RecoveredEditorDraftCompareDialog
      draft={comparing}
      onOpenChange={(open) => !open && setComparing(null)}
    />
  )
}
