import { createHash } from 'node:crypto'
import type { BundledSkillObserved } from '../../../shared/bundled-skill-plan'
import { isOsMetadataSkillEntryName } from '../skill-package-identity'
import type { BundledSkillSource } from './bundled-skill-sources'
import type { BundledSkillFilesystem, BundledSkillPathObservation } from './filesystem'

export type BundledSkillFolderClass = 'absent' | 'current' | 'released' | 'edited' | 'other'

export type ClassifiedBundledSkillPath = {
  folderClass: BundledSkillFolderClass
  observed: BundledSkillObserved
  /** Where a link resolves (null when broken); not part of `observed`. */
  linkRealPath?: string | null
}

const SKILL_FILE = 'SKILL.md'
const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u
const FRONTMATTER_NAME = /^name:[ \t]*(["']?)(.+?)\1[ \t]*$/mu

/** sha256 of LF-normalised text, so a pre-#8624 CRLF clone still matches its release. */
export function bundledSkillTextDigest(bytes: Uint8Array): string {
  let normalized: Uint8Array = bytes
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    normalized = Buffer.from(text.replace(/\r\n?/gu, '\n'), 'utf8')
  } catch {
    // Not UTF-8, so it matches no release; hash the raw bytes.
  }
  return createHash('sha256').update(normalized).digest('hex')
}

function frontmatterName(bytes: Buffer): string | null {
  const frontmatter = FRONTMATTER.exec(bytes.toString('utf8'))?.[1]
  return (frontmatter && FRONTMATTER_NAME.exec(frontmatter)?.[2]?.trim()) || null
}

/** What a folder is, from one observation; `plan` classifies a batch, `execute` one path. */
export function classifyBundledSkillObservation(
  seen: BundledSkillPathObservation | null | undefined,
  source: BundledSkillSource,
  currentDigest: string
): ClassifiedBundledSkillPath {
  if (!seen) {
    return { folderClass: 'other', observed: { kind: 'unreadable' } }
  }
  if (seen.kind === 'missing') {
    return { folderClass: 'absent', observed: { kind: 'absent' } }
  }
  if (seen.kind === 'symlink') {
    const target = seen.linkTarget ?? null
    return {
      folderClass: 'other',
      observed: target === null ? { kind: 'unreadable' } : { kind: 'link', target },
      linkRealPath: seen.linkRealPath ?? null
    }
  }
  if (seen.kind !== 'directory') {
    return { folderClass: 'other', observed: { kind: 'file', mtimeMs: seen.mtimeMs } }
  }
  if (!seen.entries) {
    return { folderClass: 'other', observed: { kind: 'unreadable' } }
  }
  // Only a plain file is OS-authored; a folder or link wearing the name is content.
  const entries = seen.entries
    .filter((entry) => !(entry.kind === 'file' && isOsMetadataSkillEntryName(entry.name)))
    .map((entry) => `${entry.name}:${entry.kind}`)
    .sort()
  const bytes = entries.includes(`${SKILL_FILE}:file`) ? (seen.skillFile ?? null) : null
  const skillDigest = bytes ? bundledSkillTextDigest(bytes) : null
  const observed: BundledSkillObserved = { kind: 'folder', entries, skillDigest }
  if (entries.length === 1 && skillDigest !== null) {
    if (skillDigest === currentDigest) {
      return { folderClass: 'current', observed }
    }
    if (source.releasedDigests.includes(skillDigest)) {
      return { folderClass: 'released', observed }
    }
  }
  return {
    folderClass: bytes && frontmatterName(bytes) === source.name ? 'edited' : 'other',
    observed
  }
}

/**
 * The one reader of a target path. `plan` classifies with it and `execute` re-observes with
 * it, so both compare the same `observed` shape.
 */
export async function classifyBundledSkillPath(
  filesystem: BundledSkillFilesystem,
  path: string,
  source: BundledSkillSource,
  currentDigest: string
): Promise<ClassifiedBundledSkillPath> {
  return classifyBundledSkillObservation(
    (await filesystem.observe([path])).get(path),
    source,
    currentDigest
  )
}
