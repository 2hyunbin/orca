import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LegacyRelayHiddenOutput } from './legacy-relay-hidden-output'

const PTY = 'ssh:ssh-box@@pty-1'

let sent: { data: string[]; replays: string[] }
let reread: ReturnType<typeof vi.fn<(ptyId: string) => Promise<string | null>>>

function gate(): LegacyRelayHiddenOutput {
  return new LegacyRelayHiddenOutput({
    onData: (_ptyId, data) => sent.data.push(data),
    onReplay: (_ptyId, replay) => sent.replays.push(replay),
    reread
  })
}

beforeEach(() => {
  sent = { data: [], replays: [] }
  reread = vi.fn(async () => 'SCREEN')
})

describe('a bridged pane no visible view shows', () => {
  it('sends none of its output to the window, and one fresh screen once shown', async () => {
    const subject = gate()
    subject.setPaused(PTY, true)
    for (let i = 0; i < 1000; i++) {
      subject.onData(PTY, 'x'.repeat(4096))
    }
    expect(sent.data).toEqual([])
    subject.setPaused(PTY, false)
    await vi.waitFor(() => expect(sent.replays).toEqual(['SCREEN']))
    expect(reread).toHaveBeenCalledTimes(1)
    subject.onData(PTY, 'live')
    expect(sent.data).toEqual(['live'])
  })

  it('passes a shown pane’s output straight through', () => {
    const subject = gate()
    subject.onData(PTY, 'a')
    subject.onData('ssh:ssh-box@@pty-2', 'b')
    expect(sent.data).toEqual(['a', 'b'])
  })

  it('re-reads nothing for a pane that printed nothing while hidden', async () => {
    const subject = gate()
    subject.setPaused(PTY, true)
    subject.setPaused(PTY, false)
    await Promise.resolve()
    expect(reread).not.toHaveBeenCalled()
  })

  it('re-reads nothing once a reattach already sent the whole screen', async () => {
    const subject = gate()
    subject.setPaused(PTY, true)
    subject.onData(PTY, 'hidden')
    subject.screenSent(PTY)
    subject.setPaused(PTY, false)
    await Promise.resolve()
    expect(reread).not.toHaveBeenCalled()
  })

  it('holds a screen that arrives after the pane was hidden again, and reads a newer one', async () => {
    let answer: (screen: string) => void = () => {}
    reread.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
    const subject = gate()
    subject.setPaused(PTY, true)
    subject.onData(PTY, 'hidden')
    subject.setPaused(PTY, false)
    subject.setPaused(PTY, true)
    answer('STALE')
    await vi.waitFor(() => expect(reread).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    expect(sent.replays).toEqual([])
    subject.setPaused(PTY, false)
    await vi.waitFor(() => expect(sent.replays).toEqual(['SCREEN']))
  })

  it('leaves a pane whose screen cannot be read to the bridge’s own reattach', async () => {
    reread.mockRejectedValueOnce(new Error('ssh down'))
    const subject = gate()
    subject.setPaused(PTY, true)
    subject.onData(PTY, 'hidden')
    subject.setPaused(PTY, false)
    await vi.waitFor(() => expect(reread).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    expect(sent.replays).toEqual([])
  })

  it('forgets an exited pane, so a reused id starts shown', () => {
    const subject = gate()
    subject.setPaused(PTY, true)
    subject.forget(PTY)
    subject.onData(PTY, 'next')
    expect(sent.data).toEqual(['next'])
  })
})
