import React from 'react'
import { CirclePause } from 'lucide-react'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'

// Why: autosave silently stops writing an undone reload; say so, or the tab looks stuck unsaved.
export function AutosavePausedNotice(): React.JSX.Element | null {
  const autoSaveEnabled = useAppStore((state) => state.settings?.editorAutoSave === true)
  const saveShortcut = useShortcutLabel('editor.save')
  if (!autoSaveEnabled) {
    return null
  }
  return (
    <div
      role="status"
      className="flex items-center gap-2 border-b border-border/60 bg-muted/40 px-4 py-2 text-xs text-muted-foreground"
    >
      <CirclePause className="size-3.5 shrink-0" />
      <span className="min-w-0">
        {translate(
          'auto.components.editor.AutosavePausedNotice.message',
          'Autosave paused after undoing a reload. Press {{value0}} to save.',
          { value0: saveShortcut }
        )}
      </span>
    </div>
  )
}
