import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { basename } from '@/lib/path'
import { normalizeAbsolutePathForComparison } from '@/components/right-sidebar/file-explorer-paths'
import type { OpenFile } from '@/store/slices/editor'

type PausedFile = Pick<OpenFile, 'filePath' | 'runtimeEnvironmentId'>

// Why: autosave must not convert a non-UTF-8 file unasked; an explicit save consents and lifts the pause.
const pausedFiles = new Set<string>()

function pauseKey(file: PausedFile): string {
  return `${file.runtimeEnvironmentId?.trim() || 'client'}::${normalizeAbsolutePathForComparison(file.filePath)}`
}

export function isAutosavePausedForNonUtf8File(file: PausedFile): boolean {
  return pausedFiles.size > 0 && pausedFiles.has(pauseKey(file))
}

/** Tells the user once per pause, so a refused autosave never repeats as a loop of notices. */
export function pauseAutosaveForNonUtf8File(file: PausedFile): void {
  const key = pauseKey(file)
  if (pausedFiles.has(key)) {
    return
  }
  pausedFiles.add(key)
  toast.warning(
    translate(
      'auto.components.editor.editor.save.notUtf8.notice',
      "Autosave is paused for {{name}} because it isn't UTF-8 text. Save it yourself to convert it to UTF-8.",
      { name: basename(file.filePath) }
    )
  )
}

export function resumeAutosaveForNonUtf8File(file: PausedFile): void {
  pausedFiles.delete(pauseKey(file))
}

export function __clearNonUtf8AutosavePausesForTests(): void {
  pausedFiles.clear()
}
