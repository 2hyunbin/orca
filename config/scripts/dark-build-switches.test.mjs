import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const {
  assertNoDarkOutputOfOffSwitches,
  assertNotDarkBuild,
  darkBuildDefines,
  darkBuildMarkers,
  turnedOnDarkBuildDefines
} = createRequire(import.meta.url)('../dark-build-switches.cjs')

const scratch = []
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('dark build switches', () => {
  it.each(['ORCA_LAYOUT_OWNER'])('compiles the dark path in only when %s=main asks', (variable) => {
    expect(darkBuildDefines({ [variable]: 'main' })[variable]).toBe('"main"')
    expect(darkBuildDefines({ [variable]: 'window' })[variable]).toBe('"window"')
    expect(darkBuildDefines({})[variable]).toBe('"window"')
    expect(turnedOnDarkBuildDefines({ [variable]: 'main' })).toEqual({ [variable]: '"main"' })
    expect(turnedOnDarkBuildDefines({})).toEqual({})
  })

  it('keeps the layout-owner marker name packaging already refuses', () => {
    expect(darkBuildMarkers({ ORCA_LAYOUT_OWNER: 'main' })).toEqual([
      {
        fileName: 'ORCA_LAYOUT_OWNER_MAIN',
        text: 'Built with ORCA_LAYOUT_OWNER=main, for dark testing only.\n'
      }
    ])
    expect(darkBuildMarkers({})).toEqual([])
  })

  it.each(['ORCA_LAYOUT_OWNER'])(
    'refuses %s at packaging time, and any output its dark build marked',
    async (variable) => {
      const clean = await mkdtemp(join(tmpdir(), 'orca-dark-build-clean-'))
      const dark = await mkdtemp(join(tmpdir(), 'orca-dark-build-dark-'))
      scratch.push(clean, dark)
      const [marker] = darkBuildMarkers({ [variable]: 'main' })
      await writeFile(join(dark, marker.fileName), marker.text)

      expect(() => assertNotDarkBuild([clean], {})).not.toThrow()
      expect(() => assertNotDarkBuild([clean], { [variable]: 'main' })).toThrow(`${variable}=main`)
      expect(() => assertNotDarkBuild([clean, dark], {})).toThrow(dark)
    }
  )

  it('lets a dark build carry its own output, and refuses it in any other build', async () => {
    const dark = await mkdtemp(join(tmpdir(), 'orca-dark-build-own-'))
    scratch.push(dark)
    const [marker] = darkBuildMarkers({ ORCA_LAYOUT_OWNER: 'main' })
    await writeFile(join(dark, marker.fileName), marker.text)

    expect(() =>
      assertNoDarkOutputOfOffSwitches([dark], { ORCA_LAYOUT_OWNER: 'main' })
    ).not.toThrow()
    expect(() => assertNoDarkOutputOfOffSwitches([dark], {})).toThrow(dark)
  })

  it('no longer treats the retired sidebar-inputs switch as dark', () => {
    expect(darkBuildDefines({ ORCA_SIDEBAR_INPUTS: 'main' })).not.toHaveProperty(
      'ORCA_SIDEBAR_INPUTS'
    )
    expect(darkBuildMarkers({ ORCA_SIDEBAR_INPUTS: 'main' })).toEqual([])
    expect(() => assertNotDarkBuild([], { ORCA_SIDEBAR_INPUTS: 'main' })).not.toThrow()
  })
})
