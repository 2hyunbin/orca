import { describe, expect, it } from 'vitest'
import {
  WorkspaceViewReportFence,
  WorkspaceViewReporter,
  type ClientView,
  type ClientViewReport
} from './workspace-view-reporter'

const VIEW: ClientView = {
  workspaces: [{ hostId: 'ssh:gpu', worktreeId: 'repo::/w/a' }],
  tabs: [{ hostId: 'ssh:gpu', tabId: 'tab-1' }]
}

function reporter() {
  let now = 1_000
  const sent: ClientViewReport[] = []
  const reporter = new WorkspaceViewReporter(
    (report) => sent.push(report),
    () => now
  )
  return { reporter, sent, advance: (ms: number) => (now += ms) }
}

describe('WorkspaceViewReporter', () => {
  it('qualifies workspaces and tabs by host and keeps today’s ids for older hosts', () => {
    const client = reporter()
    client.reporter.report(VIEW, 30_000)
    expect(client.sent).toEqual([
      {
        seq: 1,
        workspaceIds: ['repo::/w/a'],
        tabIds: ['tab-1'],
        workspaceKeys: ['ssh:gpu|repo::/w/a'],
        tabKeys: ['ssh:gpu|tab-1'],
        presentForMs: 30_000
      }
    ])
  })

  it('re-sends the last report after a reconnect with what is left of its lease', () => {
    const client = reporter()
    client.reporter.reconnected()
    expect(client.sent).toEqual([])
    client.reporter.report(VIEW, 30_000)
    client.advance(20_000)
    client.reporter.reconnected()
    expect(client.sent.at(-1)).toMatchObject({ seq: 2, presentForMs: 10_000 })
    client.advance(60_000)
    client.reporter.reconnected()
    expect(client.sent.at(-1)).toMatchObject({ seq: 3, presentForMs: 0 })
  })

  it('keeps an untracked lease untracked across a reconnect', () => {
    const client = reporter()
    client.reporter.report(VIEW, null)
    client.reporter.reconnected()
    expect(client.sent.at(-1)?.presentForMs).toBeNull()
  })
})

describe('WorkspaceViewReportFence', () => {
  it('drops a report that arrives after a newer one from the same connection', () => {
    const client = reporter()
    client.reporter.report(VIEW, 1)
    client.reporter.report({ workspaces: [], tabs: [] }, 1)
    const [older, newer] = client.sent
    const fence = new WorkspaceViewReportFence()
    expect(fence.accept('phone', newer!)).toEqual({ workspaceKeys: [], tabKeys: [] })
    expect(fence.accept('phone', older!)).toBeNull()
    // Another connection's order is its own.
    expect(fence.accept('desktop', older!)).not.toBeNull()
  })

  it('names only the targets a report newly shows', () => {
    const client = reporter()
    const fence = new WorkspaceViewReportFence()
    client.reporter.report(VIEW, null)
    expect(fence.accept('phone', client.sent[0]!)).toEqual({
      workspaceKeys: ['ssh:gpu|repo::/w/a'],
      tabKeys: ['ssh:gpu|tab-1']
    })
    // The same tab id on another host is another tab.
    client.reporter.report(
      { ...VIEW, tabs: [...VIEW.tabs, { hostId: 'local', tabId: 'tab-1' }] },
      null
    )
    expect(fence.accept('phone', client.sent[1]!)).toEqual({
      workspaceKeys: [],
      tabKeys: ['local|tab-1']
    })
  })
})
