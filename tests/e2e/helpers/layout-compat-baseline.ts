/**
 * Mixed-version, two-client and phone baselines (layout rework P3). Each scenario reduces what the
 * server and its clients report to a shape with stable labels in place of generated ids, and
 * compares it with the shape recorded on main in `layout-compat-baselines.json`. A change that
 * moves a scenario updates its recorded shape in the same PR, so every difference is reviewed.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { TestInfo } from '@stablyai/playwright-test'
import { expect } from './orca-app'
import type { RuntimeClient } from '../../../src/cli/runtime/client'
import { decodePairingOffer } from '../../../src/shared/pairing'
import { pairedRuntimeConnectionFromOffer } from '../../../src/shared/paired-runtime-connection'
import { subscribeRemoteRuntimeRequest } from '../../../src/shared/remote-runtime-client'
import type { RuntimeMobileSessionTabsResult } from '../../../src/shared/runtime-session-contracts'
import type { RuntimeTerminalListResult } from '../../../src/shared/runtime-terminal-contracts'
import type { TerminalPaneLayoutNode } from '../../../src/shared/terminal-tab-types'
import type { PublishedWorkspaceLayout } from '../../../src/shared/workspace-layout/workspace-layout-published'
import { readWorkspaceLayoutStreamFrame } from '../../../src/shared/workspace-layout/workspace-layout-stream-frames'

const BASELINE_FILE = path.join(process.cwd(), 'tests', 'e2e', 'layout-compat-baselines.json')
/** Also writes each observation here, one file per scenario and platform, to record a baseline. */
export const LAYOUT_COMPAT_REPORT_DIR_ENV = 'ORCA_LAYOUT_COMPAT_REPORT_DIR'

type BaselineFile = { scenarios: Record<string, Partial<Record<NodeJS.Platform, unknown>>> }

/** Stable names for generated ids, numbered in first-seen order within one scenario. */
export class IdLabels {
  private readonly labels = new Map<string, string>()
  private readonly counts = new Map<string, number>()

  label(kind: string, id: string | null | undefined): string | null {
    if (!id) {
      return null
    }
    const key = `${kind}:${id}`
    let label = this.labels.get(key)
    if (!label) {
      const next = (this.counts.get(kind) ?? 0) + 1
      this.counts.set(kind, next)
      label = `${kind}${next}`
      this.labels.set(key, label)
    }
    return label
  }

  /** A PTY id as its minting kind plus a label: daemon ids carry `@@`, serve-minted ones `serve-`. */
  pty(id: string | null | undefined): string | null {
    if (!id) {
      return null
    }
    const kind = id.includes('@@') ? 'pty@@' : id.startsWith('serve-') ? 'ptyServe' : 'pty'
    return this.label(kind, id)
  }
}

function round(ratio: number | undefined): number {
  return Math.round((ratio ?? 0.5) * 10) / 10
}

export type PaneTreeShape =
  | string
  | { split: 'vertical' | 'horizontal'; ratio: number; first: PaneTreeShape; second: PaneTreeShape }

export function paneTreeShape(
  node: TerminalPaneLayoutNode | null | undefined,
  labels: IdLabels
): PaneTreeShape | null {
  if (!node) {
    return null
  }
  if (node.type === 'leaf') {
    return labels.label('leaf', node.leafId)!
  }
  return {
    split: node.direction,
    // Divider drags land on whole pixels; a tenth keeps the shape stable across window sizes.
    ratio: round(node.ratio),
    first: paneTreeShape(node.first, labels)!,
    second: paneTreeShape(node.second, labels)!
  }
}

/** `session.tabs.list` as every client version reads it: groups, rows, pane trees and titles. */
export function sessionTabsShape(result: RuntimeMobileSessionTabsResult, labels: IdLabels) {
  const tabLabel = (id: string) => labels.label('tab', id)
  // A terminal row's id names its pane; the strip and groups name the tab.
  const rowTab = (id: string) => {
    const row = result.tabs.find((tab) => tab.id === id)
    return tabLabel(row?.type === 'terminal' ? row.parentTabId : id)
  }
  return {
    activeTab: result.activeTabId ? rowTab(result.activeTabId) : null,
    groups: (result.tabGroups ?? []).map((group) => ({
      tabs: group.tabOrder.map(tabLabel),
      active: group.activeTabId ? rowTab(group.activeTabId) : null
    })),
    rows: result.tabs.map((tab) =>
      tab.type === 'terminal'
        ? {
            type: tab.type,
            tab: tabLabel(tab.parentTabId),
            leaf: labels.label('leaf', tab.leafId),
            pty: labels.pty(tab.ptyId),
            title: tab.title,
            ...(tab.isPinned ? { pinned: true } : {}),
            ...(tab.parentLayout
              ? {
                  tree: paneTreeShape(tab.parentLayout.root, labels),
                  paneTitles: Object.entries(tab.parentLayout.titlesByLeafId ?? {})
                    .map(([leafId, title]) => `${labels.label('leaf', leafId)}=${title}`)
                    .sort()
                }
              : {})
          }
        : { type: tab.type, tab: tabLabel(tab.id), title: tab.title }
    )
  }
}

export async function readSessionTabs(
  client: RuntimeClient,
  worktree: string
): Promise<RuntimeMobileSessionTabsResult> {
  return (await client.call<RuntimeMobileSessionTabsResult>('session.tabs.list', { worktree }))
    .result
}

/** The host's live terminals: which pane each PTY is recorded under, and its title. */
export async function readTerminals(client: RuntimeClient, worktree: string, labels: IdLabels) {
  const { terminals } = (
    await client.call<RuntimeTerminalListResult>('terminal.list', { worktree })
  ).result
  return terminals
    .map((terminal) => ({
      tab: labels.label('tab', terminal.tabId),
      leaf: labels.label('leaf', terminal.leafId),
      pty: labels.pty(terminal.ptyId),
      title: terminal.title
    }))
    .sort((a, b) => String(a.pty).localeCompare(String(b.pty)))
}

/** One `layout.subscribe` snapshot from a host with a runtime-scope pairing. */
export async function readPublishedLayout(
  pairingUrl: string,
  worktreeId: string
): Promise<PublishedWorkspaceLayout | null> {
  let resolveSnapshot: (layout: PublishedWorkspaceLayout | null) => void = () => {}
  let rejectSnapshot: (error: Error) => void = () => {}
  const snapshot = new Promise<PublishedWorkspaceLayout | null>((resolve, reject) => {
    resolveSnapshot = resolve
    rejectSnapshot = reject
  })
  const subscription = await subscribeRemoteRuntimeRequest<unknown>(
    pairedRuntimeConnectionFromOffer(decodePairingOffer(pairingUrl)),
    'layout.subscribe',
    {},
    30_000,
    {
      onResponse: (response) => {
        if (!response.ok) {
          rejectSnapshot(new Error(`layout.subscribe: ${response.error.code}`))
          return
        }
        const frame = readWorkspaceLayoutStreamFrame(response.result)
        if (frame?.type === 'snapshot') {
          resolveSnapshot(
            frame.workspaces.find((entry) => entry.layout.worktreeId === worktreeId)?.layout ?? null
          )
        }
      },
      onError: (error) => rejectSnapshot(error)
    }
  )
  try {
    return await snapshot
  } finally {
    subscription.close()
  }
}

/** The runtime's published layout for one workspace, the model the rework will hold. */
export function publishedLayoutShape(layout: PublishedWorkspaceLayout | null, labels: IdLabels) {
  if (!layout) {
    return null
  }
  return {
    groups: layout.groups.map((group) => group.tabIds.map((id) => labels.label('tab', id))),
    tabs: layout.tabs.map((tab) => ({
      tab: labels.label('tab', tab.id),
      kind: tab.kind,
      customTitle: tab.customTitle,
      ...(tab.isPinned ? { pinned: true } : {}),
      ...(tab.terminal
        ? {
            tree: paneTreeShape(tab.terminal.root, labels),
            panes: tab.terminal.panes.map((pane) => ({
              leaf: labels.label('leaf', pane.leafId),
              pty: labels.pty(pane.ptyId),
              ...(pane.title ? { title: pane.title } : {})
            }))
          }
        : {})
    }))
  }
}

function readBaselines(): BaselineFile {
  return JSON.parse(readFileSync(BASELINE_FILE, 'utf8'))
}

/** Fails unless `observation` equals the shape recorded on main for this scenario and platform. */
export async function expectLayoutCompatBaseline(
  testInfo: TestInfo,
  scenario: string,
  observation: unknown
): Promise<void> {
  const body = `${JSON.stringify(observation, null, 2)}\n`
  await testInfo.attach(`${scenario}.json`, { body, contentType: 'application/json' })
  const reportDir = process.env[LAYOUT_COMPAT_REPORT_DIR_ENV]
  if (reportDir) {
    mkdirSync(reportDir, { recursive: true })
    writeFileSync(path.join(reportDir, `${scenario}.${process.platform}.json`), body)
  }
  const recorded = readBaselines().scenarios[scenario]?.[process.platform]
  // The observation goes in the message, so a CI log alone is enough to record a new platform.
  expect(
    recorded,
    `no ${process.platform} baseline for ${scenario}; record one on main. Observed:\n${body}`
  ).toBeDefined()
  // Round-trip so `undefined` fields compare as the recorded JSON does.
  expect(JSON.parse(body)).toEqual(recorded)
}

/**
 * Reads until four reads in a row agree, so a step records where the server came to rest rather
 * than a value mid-update. Only a convergence wait: the recorded shape is compared, never polled for.
 */
export async function readSettled<T>(read: () => Promise<T>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last = JSON.stringify(await read())
  let same = 1
  while (same < 4) {
    if (Date.now() > deadline) {
      throw new Error(`never settled within ${timeoutMs} ms; last read: ${last}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
    const next = JSON.stringify(await read())
    same = next === last ? same + 1 : 1
    last = next
  }
  return JSON.parse(last)
}
