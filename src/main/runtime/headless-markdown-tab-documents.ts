/**
 * A phone's Markdown read and save on a host with no window: main answers from the file on disk,
 * with the same result shapes the window's editor relay returns. An unsaved draft a window left in
 * the saved session is that window's view state: main never shows or edits it, and the desktop's
 * restore check reports any disk change it missed when it next opens the tab.
 */
import {
  hashMarkdownContent,
  isMarkdownContentByteLengthOverLimit,
  MOBILE_MARKDOWN_EDIT_MAX_BYTES,
  MOBILE_MARKDOWN_READ_MAX_BYTES,
  truncateMobileMarkdownRead,
  type RuntimeMarkdownReadTabResult,
  type RuntimeMarkdownSaveTabResult
} from '../../shared/mobile-markdown-document'
import type { RuntimeMobileSessionMarkdownTab } from '../../shared/runtime-types'
import type {
  FileWriteDiskPrecondition,
  FileWriteResult
} from '../../shared/file-write-disk-precondition'
import { getDiskBaselineSignature } from '../../shared/disk-baseline-signature'
import type {
  PersistedOpenFile,
  WorkspaceSessionState
} from '../../shared/workspace-session-state-types'
import { findListedEditorFile } from './mobile-session-editor-projection'

export type HeadlessMarkdownFile = { content: string; byteLength: number }

export type HeadlessMarkdownTabHost = {
  getWorkspaceSessionForWorktree(worktreeId: string): WorkspaceSessionState | null | undefined
  /** At most `maxBytes` of the file decoded, and its full size; throws `binary_file` for binary. */
  readFile(worktreeId: string, filePath: string, maxBytes: number): Promise<HeadlessMarkdownFile>
  writeFileIfUnchanged(
    worktreeId: string,
    filePath: string,
    content: string,
    precondition: FileWriteDiskPrecondition
  ): Promise<FileWriteResult>
}

type ListedMarkdownTab = Pick<RuntimeMobileSessionMarkdownTab, 'id' | 'filePath'>

// Why up to 4 bytes over: a character straddling the cap still decodes whole before the cut.
const READ_SLACK_BYTES = 4

const saveQueues = new Map<string, Promise<unknown>>()

function savedEditorFile(
  host: HeadlessMarkdownTabHost,
  worktreeId: string,
  tab: ListedMarkdownTab
): PersistedOpenFile {
  const session = host.getWorkspaceSessionForWorktree(worktreeId)
  const files = session?.openFilesByWorktree?.[worktreeId] ?? []
  const file = session ? findListedEditorFile(files, session, worktreeId, tab) : undefined
  if (!file || file.language !== 'markdown') {
    throw new Error('tab_not_found')
  }
  return file
}

function readOnlyReason(
  file: PersistedOpenFile,
  byteLength: number
): RuntimeMarkdownReadTabResult['readOnlyReason'] {
  // Why: the editor never saves a read-only tab (a log view), so the phone may not either.
  if (file.readOnly) {
    return 'unsupported_tab'
  }
  return byteLength > MOBILE_MARKDOWN_EDIT_MAX_BYTES ? 'file_too_large' : undefined
}

export async function readHeadlessMarkdownTab(
  host: HeadlessMarkdownTabHost,
  worktreeId: string,
  tab: ListedMarkdownTab
): Promise<RuntimeMarkdownReadTabResult> {
  const file = savedEditorFile(host, worktreeId, tab)
  const disk = await host.readFile(
    worktreeId,
    file.filePath,
    MOBILE_MARKDOWN_READ_MAX_BYTES + READ_SLACK_BYTES
  )
  const preview = truncateMobileMarkdownRead(disk.content)
  const reason = readOnlyReason(file, disk.byteLength)
  return {
    tabId: tab.id,
    filePath: file.filePath,
    relativePath: file.relativePath,
    content: preview.content,
    isDirty: false,
    version: hashMarkdownContent(preview.content),
    source: 'file',
    editable: reason === undefined,
    ...(reason ? { readOnlyReason: reason } : {}),
    ...(disk.byteLength > MOBILE_MARKDOWN_READ_MAX_BYTES
      ? { truncated: true, byteLength: disk.byteLength }
      : {})
  }
}

export async function saveHeadlessMarkdownTab(
  host: HeadlessMarkdownTabHost,
  worktreeId: string,
  tab: ListedMarkdownTab,
  baseVersion: string,
  content: string
): Promise<RuntimeMarkdownSaveTabResult> {
  if (isMarkdownContentByteLengthOverLimit(content, MOBILE_MARKDOWN_EDIT_MAX_BYTES)) {
    throw new Error('file_too_large')
  }
  const key = `${worktreeId}\0${savedEditorFile(host, worktreeId, tab).filePath}`
  const previous = saveQueues.get(key) ?? Promise.resolve()
  const save = previous
    .catch(() => undefined)
    .then(() => saveOnce(host, worktreeId, tab, baseVersion, content))
  saveQueues.set(key, save)
  try {
    return await save
  } finally {
    if (saveQueues.get(key) === save) {
      saveQueues.delete(key)
    }
  }
}

async function saveOnce(
  host: HeadlessMarkdownTabHost,
  worktreeId: string,
  tab: ListedMarkdownTab,
  baseVersion: string,
  content: string
): Promise<RuntimeMarkdownSaveTabResult> {
  const file = savedEditorFile(host, worktreeId, tab)
  const disk = await host.readFile(worktreeId, file.filePath, MOBILE_MARKDOWN_EDIT_MAX_BYTES + 1)
  const reason = readOnlyReason(file, disk.byteLength)
  if (reason) {
    throw new Error(reason)
  }
  const saved = { tabId: tab.id, isDirty: false as const, version: hashMarkdownContent(content) }
  if (hashMarkdownContent(disk.content) !== baseVersion) {
    // Why: a repeated save tap that already landed is a success, not a conflict.
    if (disk.content === content) {
      return { ...saved, content }
    }
    throw new Error('conflict')
  }
  const written = await host.writeFileIfUnchanged(worktreeId, file.filePath, content, {
    expectedSignature: getDiskBaselineSignature(disk.content)
  })
  if (!written.ok) {
    throw new Error('conflict')
  }
  return { ...saved, content }
}
