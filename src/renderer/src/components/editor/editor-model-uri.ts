import { URI } from 'monaco-editor/esm/vs/base/common/uri.js'

const FILE_SCHEME = /^file:/i
// Monaco keeps closed-file undo for this scheme, and its default labels show the URI path.
const OWNED_SCHEME = 'vscode-remote'
const OWNED_SCHEME_PREFIX = /^vscode-remote:/i

/** Two FNV-1a lanes: a short, stable authority per owner, so different owners don't collide. */
function ownerAuthority(ownerKey: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193
  for (let index = 0; index < ownerKey.length; index += 1) {
    const code = ownerKey.charCodeAt(index)
    a = Math.imul(a ^ code, 0x01000193) >>> 0
    b = Math.imul(b ^ code, 0x811c9dc5) >>> 0
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')
}

/**
 * The single filesystem-path -> Monaco model key function. Monaco keys its model registry by
 * `uri.toString()`, so creation, lookup and ownership comparison must all go through this.
 *
 * Why not `Uri.parse`: it reads `C:\src\a.ts` as scheme `c`, which fails the scheme gate in
 * `modelService._schemaShouldMaintainUndoRedoElements`, so closed-file undo is dropped for every
 * file on Windows. `Uri.file` always yields the `file:` scheme that gate allows, and the result
 * re-parses to itself, so a consumer that can only take a string (the `path` prop of
 * `@monaco-editor/react`, which calls `Uri.parse` internally) lands on the same key.
 */
export function toEditorModelUri(filePath: string, ownerKey = ''): string {
  if (OWNED_SCHEME_PREFIX.test(filePath)) {
    // An existing owned key: its authority is its owner, its path the host's path.
    const owned = URI.parse(filePath)
    return ownerKey
      ? URI.from({
          scheme: OWNED_SCHEME,
          authority: ownerAuthority(ownerKey),
          path: owned.path
        }).toString()
      : owned.toString()
  }
  const parsed = FILE_SCHEME.test(filePath) ? URI.parse(filePath) : URI.file(filePath)
  const local = URI.file(parsed.fsPath)
  if (!ownerKey) {
    return local.with({ fragment: parsed.fragment }).toString()
  }
  // Equal paths on different owners must not share text or undo history. Why the owner is the
  // authority of its own scheme: the TypeScript service names files by URI and treats
  // `scheme://authority/` as a root, so the file name stays last (TSX detection) and `..` can't
  // climb into another owner's tree or into local `file:` models.
  // The re-parse applies `toString`'s drive-letter fold; a UNC server moves into the path.
  const folded = URI.parse(local.toString())
  const path = folded.authority ? `//${folded.authority}${folded.path}` : folded.path
  return URI.from({ scheme: OWNED_SCHEME, authority: ownerAuthority(ownerKey), path }).toString()
}
