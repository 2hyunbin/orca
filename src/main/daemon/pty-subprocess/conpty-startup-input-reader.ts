import type * as pty from 'node-pty'

// Bundled ConPTY queries DA1 (or CPR when inheriting the cursor) right after it starts reading
// input, and before relaying any client output. A pane without it never reads keyboard input.
const INPUT_READER_ANNOUNCEMENTS = ['\x1b[c', '\x1b[6n'] as const
// The pseudo-window thread can report window visibility ahead of the announcement.
const WINDOW_VISIBILITY_REPORTS = ['\x1b[1t', '\x1b[2t'] as const

export type ConptyStartupVerdict = 'pending' | 'input-reader' | 'no-input-reader'
export type ConptyStartupOutcome = Exclude<ConptyStartupVerdict, 'pending'> | 'exited'

export function classifyConptyStartupOutput(output: string): ConptyStartupVerdict {
  let rest = output
  for (;;) {
    const report = WINDOW_VISIBILITY_REPORTS.find((candidate) => rest.startsWith(candidate))
    if (!report) {
      break
    }
    rest = rest.slice(report.length)
  }
  if (INPUT_READER_ANNOUNCEMENTS.some((announcement) => rest.startsWith(announcement))) {
    return 'input-reader'
  }
  // A chunk can end mid-sequence; only output that rules out every expected prefix decides.
  const expected = [...INPUT_READER_ANNOUNCEMENTS, ...WINDOW_VISIBILITY_REPORTS]
  return expected.some((sequence) => sequence.startsWith(rest)) ? 'pending' : 'no-input-reader'
}

export type ConptyStartupEvents = {
  data: string[]
  exit: { exitCode: number; signal?: number } | null
}

export type ConptyStartupWatch = {
  /** Settles on the first output that decides, or on exit before any did. */
  verdict: Promise<ConptyStartupOutcome>
  /** Hands buffered output and exit to the caller and stops buffering. */
  claim(): ConptyStartupEvents
}

/** Buffers a fresh ConPTY's output until its owner claims it, so no startup byte is lost. */
export function watchConptyStartup(proc: pty.IPty): ConptyStartupWatch {
  const events: ConptyStartupEvents = { data: [], exit: null }
  let output = ''
  let settle: (outcome: ConptyStartupOutcome) => void = () => {}
  const verdict = new Promise<ConptyStartupOutcome>((resolve) => {
    settle = resolve
  })
  let decided = false
  const dataSubscription = proc.onData((data) => {
    events.data.push(data)
    if (decided) {
      return
    }
    output += data
    const classified = classifyConptyStartupOutput(output)
    if (classified !== 'pending') {
      decided = true
      settle(classified)
    }
  })
  const exitSubscription = proc.onExit(({ exitCode, signal }) => {
    events.exit = { exitCode, ...(signal !== undefined ? { signal } : {}) }
    decided = true
    settle('exited')
  })
  return {
    verdict,
    claim: () => {
      dataSubscription.dispose()
      exitSubscription.dispose()
      return events
    }
  }
}
