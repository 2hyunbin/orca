// A divider's new ratio as an intent: the split it moved, by path from the root ("first.second";
// "" the root), and its ratio. Main applies it to its own tree, so what else that tree holds stays.

import type { TabGroupLayoutNode } from '../tab-types'
import type { TerminalPaneLayoutNode } from '../terminal-tab-types'
import { SPLIT_RATIO_TOLERANCE } from './terminal-pane-tree'

export type SplitRatioIntent = { path: string; ratio: number }

type SplitTree =
  | { type: 'leaf' }
  | { type: 'split'; first: SplitTree; second: SplitTree; ratio?: number }

const segmentsOf = (path: string): string[] => (path.length > 0 ? path.split('.') : [])
const childPath = (path: string, segment: 'first' | 'second'): string =>
  path.length > 0 ? `${path}.${segment}` : segment

/** The splits whose ratio `after` changed from `before`, two trees of one shape. */
export function changedSplitRatios(
  before: SplitTree,
  after: SplitTree,
  path = ''
): SplitRatioIntent[] {
  if (before.type !== 'split' || after.type !== 'split') {
    return []
  }
  const ratio = after.ratio ?? 0.5
  return [
    ...((before.ratio ?? 0.5) !== ratio ? [{ path, ratio }] : []),
    ...changedSplitRatios(before.first, after.first, childPath(path, 'first')),
    ...changedSplitRatios(before.second, after.second, childPath(path, 'second'))
  ]
}

/** Each split's ratio, as intents. */
export function allSplitRatios(root: SplitTree, path = ''): SplitRatioIntent[] {
  if (root.type !== 'split') {
    return []
  }
  return [
    { path, ratio: root.ratio ?? 0.5 },
    ...allSplitRatios(root.first, childPath(path, 'first')),
    ...allSplitRatios(root.second, childPath(path, 'second'))
  ]
}

/** A ratio this close to even is saved as none, as the window saves it. */
const savedRatio = (ratio: number): { ratio?: number } =>
  Math.abs(ratio - 0.5) > SPLIT_RATIO_TOLERANCE ? { ratio } : {}

function withPaneRatio(
  node: TerminalPaneLayoutNode,
  segments: readonly string[],
  ratio: number
): TerminalPaneLayoutNode | null {
  if (node.type !== 'split') {
    return null
  }
  const [segment, ...rest] = segments
  if (segment === undefined) {
    const { ratio: _previous, ...split } = node
    return { ...split, ...savedRatio(ratio) }
  }
  if (segment !== 'first' && segment !== 'second') {
    return null
  }
  const child = withPaneRatio(node[segment], rest, ratio)
  return child && (segment === 'first' ? { ...node, first: child } : { ...node, second: child })
}

function withGroupRatio(
  node: TabGroupLayoutNode,
  segments: readonly string[],
  ratio: number
): TabGroupLayoutNode | null {
  if (node.type !== 'split') {
    return null
  }
  const [segment, ...rest] = segments
  if (segment === undefined) {
    return { ...node, ratio }
  }
  if (segment !== 'first' && segment !== 'second') {
    return null
  }
  const child = withGroupRatio(node[segment], rest, ratio)
  return child && (segment === 'first' ? { ...node, first: child } : { ...node, second: child })
}

/** `root` with each intent's split at its ratio; null when one names no split of `root`. */
export function withPaneSplitRatios(
  root: TerminalPaneLayoutNode,
  ratios: readonly SplitRatioIntent[]
): TerminalPaneLayoutNode | null {
  let next: TerminalPaneLayoutNode | null = root
  for (const { path, ratio } of ratios) {
    next = next && withPaneRatio(next, segmentsOf(path), ratio)
  }
  return next
}

/** As `withPaneSplitRatios`, for a workspace's group splits, whose ratios are saved as set. */
export function withGroupSplitRatios(
  root: TabGroupLayoutNode,
  ratios: readonly SplitRatioIntent[]
): TabGroupLayoutNode | null {
  let next: TabGroupLayoutNode | null = root
  for (const { path, ratio } of ratios) {
    next = next && withGroupRatio(next, segmentsOf(path), ratio)
  }
  return next
}
