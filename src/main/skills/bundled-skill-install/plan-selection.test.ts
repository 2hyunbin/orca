import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { previewBundledSkillInstall } from './service'
import {
  makeSkillHome,
  NAME,
  NEW_TEXT,
  OLD_TEXT,
  opsOf,
  previewAndInstall,
  removeSkillHomes,
  serviceInput,
  snapshot,
  writeCopy
} from './skill-home.test-support'

const EDITED_TEXT = `---\nname: ${NAME}\n---\nmine\n`
const OTHER_TEXT = `---\nname: someone-elses-skill\n---\ntheirs\n`

afterEach(removeSkillHomes)

describe('installedOnly', () => {
  it('drops a skill with no copy anywhere, so update never installs it', async () => {
    const home = await makeSkillHome()
    const plan = await previewBundledSkillInstall({
      ...serviceInput(home),
      installedOnly: true
    })
    expect(plan.skills).toEqual([])
    // Install (no flag) would write and link it.
    expect(opsOf(await previewBundledSkillInstall(serviceInput(home)))).toEqual([
      [home.shared, 'write', undefined],
      [home.claude, 'link', undefined]
    ])
  })

  it('keeps a skill whose only copy is one the user edited', async () => {
    const home = await makeSkillHome()
    await writeCopy(home.claude, EDITED_TEXT)
    const plan = await previewBundledSkillInstall({
      ...serviceInput(home),
      installedOnly: true
    })
    expect(opsOf(plan)).toEqual([
      [home.shared, 'write', undefined],
      [home.claude, 'leave', 'edited']
    ])
  })

  it("drops a skill whose only copy is someone else's skill with the same name", async () => {
    const home = await makeSkillHome()
    await writeCopy(home.claude, OTHER_TEXT)
    const plan = await previewBundledSkillInstall({
      ...serviceInput(home),
      installedOnly: true
    })
    expect(plan.skills).toEqual([])
  })

  it('keeps a released copy and executes the same plan it previewed', async () => {
    const home = await makeSkillHome()
    await writeCopy(home.shared, OLD_TEXT)
    const input = { ...serviceInput(home), installedOnly: true }
    const { plan } = await previewAndInstall(input)
    expect(opsOf(plan)).toEqual([
      [home.shared, 'update', undefined],
      [home.claude, 'link', undefined]
    ])
    expect(await snapshot(home.shared)).toBe(`dir[SKILL.md]:${NEW_TEXT}`)
  })
})

describe("force: 'all'", () => {
  it('replaces every replaceable copy left alone and keeps a backup of each', async () => {
    const home = await makeSkillHome()
    await writeCopy(home.shared, EDITED_TEXT)
    await writeCopy(home.cursor, OTHER_TEXT)
    const input = serviceInput(home, { agents: ['cursor'] })
    expect(opsOf(await previewBundledSkillInstall(input))).toEqual([
      [home.shared, 'leave', 'edited'],
      [home.cursor, 'leave', 'other']
    ])

    const { plan } = await previewAndInstall({ ...input, force: 'all' })
    expect(opsOf(plan)).toEqual([
      [home.shared, 'replace', undefined],
      [home.cursor, 'replace', undefined]
    ])
    expect(await snapshot(home.shared)).toBe(`dir[SKILL.md]:${NEW_TEXT}`)
    const backups = join(home.home, '.agents', '.orca-skill-backups')
    const kept = await Promise.all(
      (await readdir(backups)).map((entry) => readFile(join(backups, entry, 'SKILL.md'), 'utf8'))
    )
    expect(kept.sort()).toEqual([EDITED_TEXT, OTHER_TEXT].sort())
  })
})
