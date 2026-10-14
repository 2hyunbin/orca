import { isAbsolute, relative, resolve, sep } from 'node:path'
import { isDescendantOrEqual, normalizeExistingPath } from '../ipc/filesystem-path-containment'

/** Admit a host path and retain its native suffix for account relocation. */
export async function admitTranscriptPath(root: string, candidate: string) {
  const resolvedRoot = resolve(root)
  const resolvedCandidate = resolve(candidate)
  if (isDescendantOrEqual(resolvedCandidate, resolvedRoot)) {
    const suffix = relative(resolvedRoot, resolvedCandidate)
    if (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)) {
      return { path: resolvedCandidate, relativePath: suffix }
    }
  }
  const [canonicalRoot, canonicalCandidate] = await Promise.all([
    normalizeExistingPath(resolvedRoot),
    normalizeExistingPath(resolvedCandidate)
  ])
  return isDescendantOrEqual(canonicalCandidate, canonicalRoot)
    ? { path: canonicalCandidate, relativePath: relative(canonicalRoot, canonicalCandidate) }
    : null
}
