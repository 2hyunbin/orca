import { describe, expect, it } from 'vitest'
import {
  decideEditorBufferJoin,
  decideEditorBufferRejoin,
  joinedEditorBuffer,
  type EditorBufferJoinSide
} from './editor-buffer-join'

function side(
  draft: string | undefined,
  patch: Partial<EditorBufferJoinSide['record']> = {}
): EditorBufferJoinSide {
  return {
    record: {
      isDirty: draft !== undefined,
      lastKnownDiskSignature: 'disk-1',
      externalMutation: undefined,
      pendingOwnerMigration: undefined,
      ...patch
    },
    draft
  }
}

describe('editor buffer join rules', () => {
  it('re-keys the view when no record holds the identity yet', () => {
    const joining = side('abc')
    expect(decideEditorBufferJoin(null, joining)).toBe('rekey')
    expect(joinedEditorBuffer(null, joining, 'rekey')).toBe(joining)
  })

  it('attaches a clean view, keeping the target baseline', () => {
    const target = side(undefined, { lastKnownDiskSignature: 'disk-target' })
    const joining = side(undefined, { lastKnownDiskSignature: 'disk-joining' })
    expect(decideEditorBufferJoin(target, joining)).toBe('attach')
    expect(joinedEditorBuffer(target, joining, 'attach')).toBe(target)
  })

  it('lets the dirty side win, with its draft, baseline and conflict state', () => {
    const clean = side(undefined, { lastKnownDiskSignature: 'disk-clean' })
    const dirty = side('abcd', { lastKnownDiskSignature: 'disk-old', externalMutation: 'changed' })

    expect(decideEditorBufferJoin(dirty, clean)).toBe('attach')
    expect(joinedEditorBuffer(dirty, clean, 'attach')).toBe(dirty)
    expect(decideEditorBufferJoin(clean, dirty)).toBe('adopt')
    expect(joinedEditorBuffer(clean, dirty, 'adopt')).toEqual({
      record: expect.objectContaining({
        isDirty: true,
        lastKnownDiskSignature: 'disk-old',
        externalMutation: 'changed'
      }),
      draft: 'abcd'
    })
  })

  it('merges identical dirty drafts on one baseline', () => {
    const target = side('abcd')
    const joining = side('abcd')
    expect(decideEditorBufferJoin(target, joining)).toBe('merge')
    expect(joinedEditorBuffer(target, joining, 'merge')).toBe(target)
  })

  it.each([
    ['divergent drafts', side('abc'), side('abcd')],
    [
      'equal drafts on different baselines',
      side('abc'),
      side('abc', { lastKnownDiskSignature: 'disk-2' })
    ]
  ])('detaches %s, so neither draft is dropped', (_name, target, joining) => {
    expect(decideEditorBufferJoin(target, joining)).toBe('detach')
    expect(joinedEditorBuffer(target, joining, 'detach')).toBeNull()
  })
})

describe('editor buffer rejoin rules', () => {
  it('never rejoins two dirty sides, even with identical text', () => {
    expect(decideEditorBufferRejoin(side('abc'), side('abcd'))).toBeNull()
    expect(decideEditorBufferRejoin(side('abc'), side('abc'))).toBeNull()
  })

  it('rejoins once the partner is clean: the detached dirty draft wins with its old baseline', () => {
    const detached = side('abcd', { lastKnownDiskSignature: 'disk-before-save' })
    const partner = side(undefined, { lastKnownDiskSignature: 'disk-after-save' })
    const join = decideEditorBufferRejoin(detached, partner)

    expect(join).toBe('adopt')
    expect(joinedEditorBuffer(partner, detached, join ?? 'detach')).toEqual({
      record: expect.objectContaining({
        isDirty: true,
        lastKnownDiskSignature: 'disk-before-save'
      }),
      draft: 'abcd'
    })
  })

  it('rejoins a clean detached side as a clean view of its dirty partner', () => {
    const detached = side(undefined)
    const partner = side('abc')
    const join = decideEditorBufferRejoin(detached, partner)

    expect(join).toBe('attach')
    expect(joinedEditorBuffer(partner, detached, join ?? 'detach')).toBe(partner)
  })

  it('rejoins two clean sides on the partner record', () => {
    expect(decideEditorBufferRejoin(side(undefined), side(undefined))).toBe('attach')
  })
})
