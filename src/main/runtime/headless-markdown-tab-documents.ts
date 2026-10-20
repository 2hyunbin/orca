/**
 * A phone's Markdown read and save on a host with no window: main answers from the saved editor
 * record and the file on disk, with the same result shapes the window's editor relay returns.
 */
import {
  hashMarkdownContent,
  isMarkdownContentByteLengthOverLimit,
  MOBILE_MARKDOWN_EDIT_MAX_BYTES,
  MOBILE_MARKDOWN_READ_MAX_BYTES,
  truncateMobileMarkdownRead,
  utf8ByteLength,
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
  setWorkspaceSessionForWorktree(worktreeId: string, session: WorkspaceSessionState): void
  /** At most `maxBytes` of the file decoded, and its full size; throws `binary_file` for binary. */
  readFile(worktreeId: string, filePath: string, maxBytes: number): Promise<HeadlessMarkdownFile>
  writeFileIfUnchanged(
    worktreeId: string,
    filePath: string,
    content: string,
    precondition: FileWriteDiskPrecondition
  ): Promise<FileWriteResult>
  /** Lists the tab again after its saved draft changed. */
  republishMobileSessionTabs(worktreeId: string): void
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

export async function readHeadlessMarkdownTab(
  host: HeadlessMarkdownTabHost,
  worktreeId: string,
  tab: ListedMarkdownTab
): Promise<RuntimeMarkdownReadTabResult> {
  const file = savedEditorFile(host, worktreeId, tab)
  const draft = file.dirtyDraftContent
  const text =
    draft === undefined
      ? await host.readFile(
          worktreeId,
          file.filePath,
          MOBILE_MARKDOWN_READ_MAX_BYTES + READ_SLACK_BYTES
        )
      : { content: draft, byteLength: utf8ByteLength(draft) }
  const preview = truncateMobileMarkdownRead(text.content)
  const readOnlyReason = savedReadOnlyReason(file, text.byteLength)
  return {
    tabId: tab.id,
    filePath: file.filePath,
    relativePath: file.relativePath,
    content: preview.content,
    isDirty: draft !== undefined,
    version: hashMarkdownContent(preview.content),
    source: draft === undefined ? 'file' : 'draft',
    editable: readOnlyReason === undefined,
    ...(readOnlyReason ? { readOnlyReason } : {}),
    ...(text.byteLength > MOBILE_MARKDOWN_READ_MAX_BYTES
      ? { truncated: true, byteLength: text.byteLength }
      : {})
  }
}

function savedReadOnlyReason(
  file: PersistedOpenFile,
  byteLength: number
): RuntimeMarkdownReadTabResult['readOnlyReason'] {
  // Why: the editor never saves a read-only tab (a log view), so the phone may not either.
  if (file.readOnly) {
    return 'unsupported_tab'
  }
  return byteLength > MOBILE_MARKDOWN_EDIT_MAX_BYTES ? 'file_too_large' : undefined
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
  const draft = file.dirtyDraftContent
  const disk =
    draft === undefined || !file.lastKnownDiskSignature
      ? await host.readFile(worktreeId, file.filePath, MOBILE_MARKDOWN_EDIT_MAX_BYTES + 1)
      : null
  const reason = savedReadOnlyReason(file, disk?.byteLength ?? 0)
  if (reason) {
    throw new Error(reason)
  }
  const current = draft ?? disk?.content ?? ''
  const saved = { tabId: tab.id, isDirty: false as const }
  if (hashMarkdownContent(current) !== baseVersion) {
    // Why: a repeated save tap that already landed is a success, not a conflict.
    if (current === content && draft === undefined) {
      return { ...saved, version: hashMarkdownContent(content), content }
    }
    throw new Error('conflict')
  }
  // Why the draft's own baseline: a disk edit made after the draft must refuse, not be overwritten.
  const written = await host.writeFileIfUnchanged(worktreeId, file.filePath, content, {
    expectedSignature: file.lastKnownDiskSignature ?? getDiskBaselineSignature(disk?.content ?? ''),
    ...(draft === undefined ? {} : { allowMissing: true })
  })
  if (!written.ok) {
    throw new Error('conflict')
  }
  if (draft !== undefined) {
    clearSavedDraft(host, worktreeId, tab, draft)
  }
  return { ...saved, version: hashMarkdownContent(content), content }
}

/** The phone saved over the draft, so the editor record now matches disk. */
function clearSavedDraft(
  host: HeadlessMarkdownTabHost,
  worktreeId: string,
  tab: ListedMarkdownTab,
  savedOver: string
): void {
  const session = host.getWorkspaceSessionForWorktree(worktreeId)
  const files = session?.openFilesByWorktree?.[worktreeId]
  const file = session && files ? findListedEditorFile(files, session, worktreeId, tab) : undefined
  // A draft written since is newer than this save, so it stays.
  if (!session || !files || file?.dirtyDraftContent !== savedOver) {
    return
  }
  const { dirtyDraftContent: _draft, lastKnownDiskSignature: _signature, ...cleared } = file
  host.setWorkspaceSessionForWorktree(worktreeId, {
    ...session,
    openFilesByWorktree: {
      ...session.openFilesByWorktree,
      [worktreeId]: files.map((candidate) => (candidate === file ? cleared : candidate))
    }
  })
  host.republishMobileSessionTabs(worktreeId)
}
