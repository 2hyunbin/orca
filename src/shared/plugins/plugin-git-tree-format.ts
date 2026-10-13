import { pluginRelativePathError } from './plugin-path-safety'
import { PLUGIN_TREE_MAX_BYTES, PLUGIN_TREE_MAX_ENTRIES } from './plugin-tree-limits'

const MAX_PATH_BYTES = 1024
const MAX_PATH_DEPTH = 64
export const PLUGIN_GIT_TREE_METADATA_MAX_BYTES = PLUGIN_TREE_MAX_ENTRIES * (MAX_PATH_BYTES + 128)

export type PluginGitTreeEntry =
  | { kind: 'tree'; path: string }
  | { kind: 'blob'; path: string; object: string; size: number; executable: boolean }

function portablePathIdentity(path: string): string {
  return path.normalize('NFC').toLowerCase()
}

function validatePath(path: string): void {
  const segments = path.split('/')
  if (
    pluginRelativePathError(path) ||
    path.includes('\\') ||
    Buffer.byteLength(path, 'utf8') > MAX_PATH_BYTES ||
    segments.length > MAX_PATH_DEPTH ||
    segments.some((segment) => {
      const name = portablePathIdentity(segment).replace(
        /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g,
        ''
      )
      return name === '.git' || /^\.?git~[0-9]+$/.test(name)
    })
  ) {
    throw new Error(`unsafe portable plugin Git path: ${path}`)
  }
}

export function parsePluginGitTree(bytes: Buffer): PluginGitTreeEntry[] {
  if (bytes.length > PLUGIN_GIT_TREE_METADATA_MAX_BYTES) {
    throw new Error('plugin Git tree metadata exceeds its size limit')
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (text && !text.endsWith('\0')) {
    throw new Error('truncated plugin Git tree metadata')
  }
  const records = text ? text.slice(0, -1).split('\0') : []
  if (records.length > PLUGIN_TREE_MAX_ENTRIES) {
    throw new Error(`plugin exceeds the ${PLUGIN_TREE_MAX_ENTRIES}-entry limit`)
  }
  const entries: PluginGitTreeEntry[] = []
  const paths = new Map<string, PluginGitTreeEntry>()
  const portablePaths = new Set<string>()
  let totalBytes = 0
  for (const record of records) {
    const match =
      /^(040000|100644|100755) (tree|blob) ([0-9a-f]{40}|[0-9a-f]{64}) +(-|[0-9]+)\t(.+)$/s.exec(
        record
      )
    if (!match) {
      throw new Error('plugin Git trees cannot contain symlinks, submodules or unknown entries')
    }
    const [, mode, type, object, sizeText, path] = match
    validatePath(path)
    const identity = portablePathIdentity(path)
    if (portablePaths.has(identity)) {
      throw new Error(`colliding portable plugin Git paths: ${path}`)
    }
    portablePaths.add(identity)
    let entry: PluginGitTreeEntry
    if (mode === '040000' && type === 'tree' && sizeText === '-') {
      entry = { kind: 'tree', path }
    } else if (mode !== '040000' && type === 'blob' && sizeText !== '-') {
      const size = Number(sizeText)
      if (!Number.isSafeInteger(size) || size < 0 || (totalBytes += size) > PLUGIN_TREE_MAX_BYTES) {
        throw new Error(`plugin exceeds the ${PLUGIN_TREE_MAX_BYTES}-byte limit`)
      }
      entry = { kind: 'blob', path, object, size, executable: mode === '100755' }
    } else {
      throw new Error('invalid plugin Git entry mode, type or size')
    }
    paths.set(path, entry)
    entries.push(entry)
  }
  for (const entry of entries) {
    const parent = entry.path.slice(0, entry.path.lastIndexOf('/'))
    if (entry.path.includes('/') && paths.get(parent)?.kind !== 'tree') {
      throw new Error(`missing directory in plugin Git tree: ${entry.path}`)
    }
  }
  return entries
}

export function readPluginGitBatchBlobs(
  bytes: Buffer,
  entries: readonly PluginGitTreeEntry[]
): Map<string, Buffer> {
  const blobs = new Map<string, Buffer>()
  let offset = 0
  for (const entry of entries) {
    if (entry.kind !== 'blob' || blobs.has(entry.object)) {
      continue
    }
    const end = bytes.indexOf(10, offset)
    if (end < offset || end - offset > 128) {
      throw new Error('missing plugin Git blob header')
    }
    const header = bytes.subarray(offset, end).toString('ascii')
    if (header !== `${entry.object} blob ${entry.size}`) {
      throw new Error('plugin Git blob identity or size changed')
    }
    const start = end + 1
    const next = start + entry.size
    if (next >= bytes.length || bytes[next] !== 10) {
      throw new Error('truncated plugin Git blob')
    }
    blobs.set(entry.object, bytes.subarray(start, next))
    offset = next + 1
  }
  if (offset !== bytes.length) {
    throw new Error('unexpected trailing plugin Git blob data')
  }
  return blobs
}
