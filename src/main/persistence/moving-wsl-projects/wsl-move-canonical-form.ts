/**
 * The string and key normalization behind the WSL move projection: a UNC path of the moved distro
 * and its Linux path, or any alias of the owning host, compare equal.
 */
import type { WslMoveProjectionScope } from './wsl-move-state-projection'

/** `editor:<enc worktreeId>:<enc runtime>:<enc filePath>` → its three decoded parts. */
export function parseEditorFileId(value: string): [string, string, string] | null {
  if (!value.startsWith('editor:')) {
    return null
  }
  const parts = value.slice('editor:'.length).split(':')
  if (parts.length !== 3) {
    return null
  }
  try {
    const [worktreeId, runtime, filePath] = parts.map(decodeURIComponent)
    return [worktreeId, runtime, filePath]
  } catch {
    return null
  }
}

export function createWslMoveStringNormalizer(
  scope: Pick<WslMoveProjectionScope, 'distro' | 'hostAliases'>
): (value: string) => string {
  const distro = escapeRegExp(scope.distro)
  // A UNC path of the distro, wherever it sits in the string; stops at `:` (`::workspace:` ids).
  const unc = new RegExp(
    `(?:\\\\\\\\|//)(?:wsl\\.localhost|wsl\\$)[\\\\/]${distro}((?:[\\\\/][^\\\\/:]*)*)`,
    'gi'
  )
  const fileUrl = new RegExp(`^file://(?:wsl\\.localhost|wsl\\$)/${distro}(?:/|$)`, 'i')
  const aliases = new Set(scope.hostAliases)
  const normalize = (value: string): string => {
    if (aliases.has(value)) {
      return '<H>'
    }
    const separator = value.indexOf('|')
    if (separator > 0 && aliases.has(value.slice(0, separator))) {
      return `<H>|${normalize(value.slice(separator + 1))}`
    }
    const editor = parseEditorFileId(value)
    if (editor) {
      return `editor:${editor.map((part) => encodeURIComponent(normalize(part))).join(':')}`
    }
    if (fileUrl.test(value)) {
      return value.replace(fileUrl, 'file:///')
    }
    return value.replace(unc, (_match, rest: string) => rest.replace(/\\/g, '/') || '/')
  }
  return normalize
}

/** Normalizes every string and key, drops `droppedKeys`, and sorts keys; throws on a collision. */
export function canonicalizeWslMoveValue(
  value: unknown,
  normalize: (value: string) => string,
  droppedKeys: ReadonlySet<string>
): unknown {
  if (typeof value === 'string') {
    return normalize(value)
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeWslMoveValue(item, normalize, droppedKeys))
  }
  if (!isRecord(value)) {
    return value
  }
  const entries: [string, unknown][] = []
  const originalByKey = new Map<string, string>()
  for (const [key, child] of Object.entries(value)) {
    if (droppedKeys.has(key) || child === undefined) {
      continue
    }
    const normalizedKey = normalize(key)
    const earlier = originalByKey.get(normalizedKey)
    if (earlier !== undefined) {
      throw new Error(`Two keys name the same thing after the move: ${earlier} and ${key}`)
    }
    originalByKey.set(normalizedKey, key)
    entries.push([normalizedKey, canonicalizeWslMoveValue(child, normalize, droppedKeys)])
  }
  entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return Object.fromEntries(entries)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
