// ─── Filesystem ─────────────────────────────────────────────
export type FilesystemPathFlavor = 'posix' | 'win32'

export type DirEntry = {
  name: string
  isDirectory: boolean
  isSymlink: boolean
}

export type FileDocument = {
  filePath: string
  relativePath: string
  basename: string
  name: string
}

export type MarkdownDocument = FileDocument

// ─── Filesystem watcher ─────────────────────────────────────
export type FsChangeEvent = {
  kind: 'create' | 'update' | 'delete' | 'rename' | 'overflow'
  absolutePath: string
  oldAbsolutePath?: string
  isDirectory?: boolean
}

export type FsChangedPayload = {
  worktreePath: string
  events: FsChangeEvent[]
}

export type WatchWorktreeArgs = {
  worktreePath: string
  connectionId?: string
  /** Worktree-relative open files: watch only their parent directories, non-recursively. Local hosts only. */
  narrowFiles?: string[]
}

/** `pending` = waiting on watcher capacity or a remote provider; the caller should keep its previous watch. */
export type WatchWorktreeStatus = 'installed' | 'pending' | 'unavailable'
