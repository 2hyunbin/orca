import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isSkillStagingEntryName } from '../skill-delete/staging-names'
import { bundledSkillTextDigest, classifyBundledSkillPath } from './classify'
import { nativeBundledSkillFilesystem } from './filesystem'
import { buildBundledSkillPlan } from './plan'
import { bundledSkillSiblingKind } from './swap'
import {
  makeSkillHome,
  NAME,
  NEW_SOURCE,
  NEW_TEXT,
  OLD_TEXT,
  removeSkillHomes,
  serviceInput,
  writeCopy
} from './skill-home.test-support'

afterEach(async () => {
  await removeSkillHomes()
})

const currentDigest = bundledSkillTextDigest(Buffer.from(NEW_TEXT))
const classify = (path: string) =>
  classifyBundledSkillPath(nativeBundledSkillFilesystem, path, NEW_SOURCE, currentDigest)

describe('classifyBundledSkillPath', () => {
  it('classifies by released bytes alone, whoever installed the copy', async () => {
    const { root } = await makeSkillHome()
    const at = (name: string) => join(root, name, NAME)
    await writeCopy(at('current'), NEW_TEXT)
    await writeCopy(at('released'), OLD_TEXT)
    await writeCopy(at('crlf'), OLD_TEXT.replace(/\n/gu, '\r\n'))
    await writeCopy(at('metadata'), OLD_TEXT, { '.DS_Store': 'x', 'Thumbs.db': 'y' })
    await writeCopy(at('edited'), `---\nname: ${NAME}\n---\nmine\n`)
    await writeCopy(at('added'), NEW_TEXT, { 'notes.md': 'mine\n' })
    await writeCopy(at('stranger'), '---\nname: someone-else\n---\n')
    await mkdir(join(at('subfolder'), '.DS_Store'), { recursive: true })
    await writeFile(join(at('subfolder'), 'SKILL.md'), NEW_TEXT)
    await mkdir(join(root, 'file'), { recursive: true })
    await writeFile(at('file'), NEW_TEXT)
    await mkdir(join(root, 'link'), { recursive: true })
    await symlink(at('current'), at('link'), 'dir')

    const classes = Object.fromEntries(
      await Promise.all(
        [
          'current',
          'released',
          'crlf',
          'metadata',
          'edited',
          'added',
          'stranger',
          'subfolder',
          'file',
          'link',
          'absent'
        ].map(async (name) => [name, (await classify(at(name))).folderClass])
      )
    )
    expect(classes).toEqual({
      current: 'current',
      released: 'released',
      crlf: 'released',
      metadata: 'released',
      edited: 'edited',
      added: 'edited',
      stranger: 'other',
      subfolder: 'edited',
      file: 'other',
      link: 'other',
      absent: 'absent'
    })
  })

  it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)(
    'reads an unlistable folder as another skill',
    async () => {
      const { root } = await makeSkillHome()
      await writeCopy(join(root, NAME), OLD_TEXT)
      await chmod(join(root, NAME), 0o000)
      try {
        expect(await classify(join(root, NAME))).toEqual({
          folderClass: 'other',
          observed: { kind: 'unreadable' }
        })
      } finally {
        await chmod(join(root, NAME), 0o755)
      }
    }
  )
})

describe('plan digest', () => {
  it('is stable across previews of the same disk and moves when the disk does', async () => {
    const home = await makeSkillHome()
    await writeCopy(home.shared, OLD_TEXT)
    const input = {
      ...serviceInput(home),
      filesystem: nativeBundledSkillFilesystem,
      sources: [NEW_SOURCE]
    }
    const first = await buildBundledSkillPlan(input)
    const second = await buildBundledSkillPlan(input)
    expect(second.plan).toEqual(first.plan)
    // Generated ids and times are made at execute time, never planned.
    expect(JSON.stringify(first.plan)).not.toMatch(/orca-(?:stage|old)-|\d{4}-\d{2}-\d{2}T/u)

    await writeFile(join(home.shared, 'SKILL.md'), NEW_TEXT)
    expect((await buildBundledSkillPlan(input)).plan.planDigest).not.toBe(first.plan.planDigest)
  })

  it('covers the bytes it would write', async () => {
    const home = await makeSkillHome()
    const input = { ...serviceInput(home), filesystem: nativeBundledSkillFilesystem }
    const before = await buildBundledSkillPlan({ ...input, sources: [NEW_SOURCE] })
    const after = await buildBundledSkillPlan({
      ...input,
      sources: [{ ...NEW_SOURCE, text: `${NEW_TEXT}more\n` }]
    })
    expect(after.plan.planDigest).not.toBe(before.plan.planDigest)
  })
})

describe('swap sibling names', () => {
  it('are hidden from discovery and recognised per skill', () => {
    for (const name of [`.${NAME}.orca-stage-1`, `.${NAME}.orca-old-1`]) {
      expect(isSkillStagingEntryName(name)).toBe(true)
    }
    expect(bundledSkillSiblingKind(NAME, `.${NAME}.orca-stage-1`)).toBe('stage')
    expect(bundledSkillSiblingKind(NAME, `.${NAME}.orca-old-1`)).toBe('old')
    expect(bundledSkillSiblingKind(NAME, `.${NAME}.orca-placement-staging-1`)).toBeNull()
    expect(bundledSkillSiblingKind('other', `.${NAME}.orca-old-1`)).toBeNull()
  })
})
