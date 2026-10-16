import { describe, expect, it } from 'vitest'
import { appendBuildOldSpaceOption, getBuildOldSpaceSizeMb } from './node-old-space-limit.mjs'

const gib = 1024 * 1024 * 1024

describe('node old-space build limit', () => {
  it('caps larger hosts at the release-runner build heap', () => {
    expect(getBuildOldSpaceSizeMb(8 * gib)).toBe(4096)
  })

  it('reserves memory for smaller arm64 hosts', () => {
    expect(getBuildOldSpaceSizeMb(4 * gib)).toBe(3072)
  })

  it('keeps unrelated NODE_OPTIONS while supplying the default build heap limit', () => {
    expect(appendBuildOldSpaceOption('--trace-warnings', 4 * gib)).toBe(
      '--trace-warnings --max-old-space-size=3072'
    )
    expect(appendBuildOldSpaceOption(undefined, 4 * gib)).toBe('--max-old-space-size=3072')
  })

  it.each([
    '--max-old-space-size=1024',
    '--max_old_space_size=1024',
    '--trace-warnings --max-old-space-size 2048',
    '"--max-old-space-size=2048"'
  ])('honors an explicit heap limit: %s', (options) => {
    expect(appendBuildOldSpaceOption(options, 8 * gib)).toBe(options)
  })
})
