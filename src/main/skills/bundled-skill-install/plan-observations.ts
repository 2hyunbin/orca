import { join } from 'node:path'
import type { BundledSkillSource } from './bundled-skill-sources'
import type { BundledSkillFilesystem, BundledSkillPathObservation } from './filesystem'
import { bundledSkillSiblingKind } from './swap'
import type { BundledSkillTargetRoot } from './targets'

/** One plan's reads: every target observed in a batch, so a guest host answers in few calls. */
export type PlanPass = {
  observations: ReadonlyMap<string, BundledSkillPathObservation | null>
  writable: Map<string, Promise<boolean>>
}

export function canWriteOnce(
  pass: PlanPass,
  filesystem: BundledSkillFilesystem,
  directory: string
): Promise<boolean> {
  const { writable } = pass
  let answer = writable.get(directory)
  if (!answer) {
    answer = filesystem.canWrite(directory)
    writable.set(directory, answer)
  }
  return answer
}

/** Each root's listing and every skill slot first, then any leftover swap siblings found there. */
export async function observeTargets(
  filesystem: BundledSkillFilesystem,
  roots: readonly BundledSkillTargetRoot[],
  sources: readonly BundledSkillSource[]
): Promise<PlanPass> {
  const first = await filesystem.observe(
    roots.flatMap((root) => [
      root.realPath,
      ...sources.map((source) => join(root.path, source.name))
    ])
  )
  const siblings = roots.flatMap((root) =>
    (first.get(root.realPath)?.entries ?? [])
      .filter((entry) => sources.some((source) => bundledSkillSiblingKind(source.name, entry.name)))
      .map((entry) => join(root.path, entry.name))
  )
  const second = siblings.length > 0 ? await filesystem.observe(siblings) : new Map()
  return { observations: new Map([...first, ...second]), writable: new Map() }
}
