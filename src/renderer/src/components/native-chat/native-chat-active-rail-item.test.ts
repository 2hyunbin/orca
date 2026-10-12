import { describe, expect, it } from 'vitest'
import {
  findActiveNativeChatRailItem,
  type NativeChatRailSlot
} from './native-chat-active-rail-item'

/** Rows 100px tall, laid end to end, as the virtualizer would report them. */
function rows(count: number, height = 100) {
  return Array.from({ length: count }, (_unused, index) => ({
    index,
    start: index * height,
    end: index * height + height
  }))
}

/** Turn shape: `u1` opens, three agent rows answer, `u2` opens the next. */
const TURNS: NativeChatRailSlot[] = [
  { turnKey: 'u1' },
  { turnKey: 'u1' },
  { turnKey: 'u1' },
  { turnKey: 'u1' },
  { turnKey: 'u2' },
  { turnKey: 'u2' },
  { turnKey: 'u2' },
  { turnKey: 'u2' },
  { turnKey: 'u2' },
  { turnKey: 'u2' }
]

const NO_TICKS: ReadonlySet<string> = new Set()

const VIEWPORT = 300
/** Ten 100px rows against a 300px viewport, scrolled off the bottom. */
const MID_SCROLL = {
  clientHeight: VIEWPORT,
  scrollHeight: 1000,
  previousActiveId: null
}

describe('active rail item', () => {
  // The whole point of resolving through `turnKey`: most of a transcript is reply,
  // and a rule that needs a user row on screen goes dark for the length of one.
  it('keeps the owning prompt lit while an agent reply fills the viewport', () => {
    expect(
      findActiveNativeChatRailItem({
        slots: TURNS,
        tickIds: NO_TICKS,
        virtualItems: rows(10),
        scrollTop: 250,
        ...MID_SCROLL
      })
    ).toBe('u1')
  })

  it('moves to the next prompt once its turn reaches the fold', () => {
    expect(
      findActiveNativeChatRailItem({
        slots: TURNS,
        tickIds: NO_TICKS,
        virtualItems: rows(10),
        scrollTop: 450,
        ...MID_SCROLL
      })
    ).toBe('u2')
  })

  it('selects the row the fold sits exactly on', () => {
    expect(
      findActiveNativeChatRailItem({
        slots: TURNS,
        tickIds: NO_TICKS,
        virtualItems: rows(10),
        scrollTop: 400,
        ...MID_SCROLL
      })
    ).toBe('u2')
  })

  // A short last turn would otherwise light its predecessor while the reader is
  // staring at the newest prompt.
  it('lights the newest turn when pinned to the bottom', () => {
    expect(
      findActiveNativeChatRailItem({
        slots: TURNS,
        tickIds: NO_TICKS,
        virtualItems: rows(10),
        scrollTop: 700,
        clientHeight: VIEWPORT,
        scrollHeight: 1000,
        previousActiveId: null
      })
    ).toBe('u2')
  })

  // A message jumped to near the end sits at the top edge a few pixels short of
  // the bottom: it is what is being read, not the newest turn.
  it('lights the turn at the fold when parked just above the bottom', () => {
    expect(
      findActiveNativeChatRailItem({
        slots: [{ turnKey: 'u1' }, { turnKey: 'u1' }, { turnKey: 'u2' }, { turnKey: 'u2' }],
        tickIds: NO_TICKS,
        virtualItems: rows(4),
        // 30px short of the end, with a `u1` row at the top edge.
        scrollTop: 100,
        clientHeight: VIEWPORT,
        scrollHeight: 430,
        previousActiveId: null
      })
    ).toBe('u1')
  })

  it('lights nothing above the first prompt', () => {
    expect(
      findActiveNativeChatRailItem({
        slots: [{ turnKey: undefined }, { turnKey: undefined }, ...TURNS],
        tickIds: NO_TICKS,
        virtualItems: rows(12),
        scrollTop: 50,
        clientHeight: VIEWPORT,
        scrollHeight: 1200,
        previousActiveId: null
      })
    ).toBeNull()
  })

  // The window reflects the last committed render, so it can lag a scroll by a
  // commit. Holding the previous tick beats blanking one.
  it('holds the previous tick when the window is stale', () => {
    expect(
      findActiveNativeChatRailItem({
        slots: TURNS,
        tickIds: NO_TICKS,
        virtualItems: [{ index: 0, start: 0, end: 100 }],
        scrollTop: 600,
        clientHeight: VIEWPORT,
        scrollHeight: 4000,
        previousActiveId: 'u1'
      })
    ).toBe('u1')
  })

  it('holds the previous tick when nothing is windowed', () => {
    expect(
      findActiveNativeChatRailItem({
        slots: TURNS,
        tickIds: NO_TICKS,
        virtualItems: [],
        scrollTop: 0,
        clientHeight: VIEWPORT,
        scrollHeight: 1000,
        previousActiveId: 'u2'
      })
    ).toBe('u2')
  })

  // A rejected send the journal recorded keeps its place but opens no turn.
  it('lights a prompt in no turn by its own id', () => {
    const slots: NativeChatRailSlot[] = [
      ...TURNS,
      { turnKey: undefined, message: { id: 'rejected', role: 'user' } }
    ]
    expect(
      findActiveNativeChatRailItem({
        slots,
        tickIds: NO_TICKS,
        virtualItems: rows(11),
        scrollTop: 800,
        clientHeight: VIEWPORT,
        scrollHeight: 1100,
        previousActiveId: null
      })
    ).toBe('rejected')
    expect(
      findActiveNativeChatRailItem({
        slots,
        tickIds: NO_TICKS,
        virtualItems: rows(11),
        scrollTop: 1010,
        ...MID_SCROLL,
        scrollHeight: 2000
      })
    ).toBe('rejected')
  })

  // A message sent mid-turn takes the running turn's key but has its own tick.
  describe('a message sent into a running turn', () => {
    const slots: NativeChatRailSlot[] = [
      { turnKey: 'u1', message: { id: 'u1', role: 'user' } },
      { turnKey: 'u1' },
      { turnKey: 'u1', message: { id: 'steer', role: 'user' } },
      { turnKey: 'u1' },
      { turnKey: 'u1' }
    ]
    const tickIds = new Set(['u1', 'steer'])

    it('lights it when pinned to the bottom', () => {
      expect(
        findActiveNativeChatRailItem({
          slots,
          tickIds,
          virtualItems: rows(5),
          scrollTop: 200,
          clientHeight: VIEWPORT,
          scrollHeight: 500,
          previousActiveId: null
        })
      ).toBe('steer')
    })

    it('lights the opener above it and itself from its row on', () => {
      const scroll = { slots, tickIds, virtualItems: rows(5), ...MID_SCROLL }
      expect(findActiveNativeChatRailItem({ ...scroll, scrollTop: 150 })).toBe('u1')
      expect(findActiveNativeChatRailItem({ ...scroll, scrollTop: 250 })).toBe('steer')
    })
  })
})
