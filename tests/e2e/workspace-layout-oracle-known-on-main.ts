import type { OracleCheck, OracleFinding } from './helpers/workspace-layout-oracle'

/**
 * Findings the layout oracle still reports on main, each tied to its cause. A rework PR that fixes
 * one removes its entry; any finding not listed here fails the scenario.
 */
type KnownOnMain = {
  /** A scenario id; a trailing '*' matches every id with that prefix. */
  scenario: string
  check: OracleCheck
  /** Prefix of the step label. */
  step?: string
  /** Only breaches seen while a step settled, not the settled layout. */
  transient?: true
  /** Rules only: the rule name each detail line starts with. */
  rule?: string
  /** Pattern the detail line must match. */
  detail?: RegExp
  cause: string
}

const TRANSIENT = /\(transient\)$/

export const LAYOUT_ORACLE_KNOWN_ON_MAIN: readonly KnownOnMain[] = [
  // Two writers: a terminal's spawn saves its tab row at once, while the window's tab bar waits in
  // main's 1 s debounced save, so the saved profile holds rows with no or an older tab bar.
  ...(['tab_bar_missing', 'tab_lists_disagree'] as const).map((rule) => ({
    scenario: '*',
    check: 'rules' as const,
    rule,
    detail: /^\w+: saved profile: /,
    cause: 'two writers'
  })),
  // STA-9417: first activation of a host-created setup split mints a second tab for the setup
  // terminal (one terminal in two panes) or leaves that terminal with no pane.
  ...(['rules', 'view', 'client', 'expected'] as const).map((check) => ({
    scenario: 'setup-split-first-activation',
    check,
    cause: 'STA-9417'
  })),
  // The in-app daemon restart drops the worktree's tabs from main while the window keeps them.
  ...(['view', 'expected', 'restart', 'marker'] as const).map((check) => ({
    scenario: 'live-daemon-restart',
    check,
    cause: 'daemon restart empties the runtime layout'
  })),
  // A worktree woken after relaunch has no tab bar in main until the window next saves it, so the
  // runtime's group is minted again with a new id.
  ...(['rules', 'view', 'client'] as const).map((check) => ({
    scenario: 'sleep-quit-resume',
    check,
    step: 'after relaunch',
    cause: 'tab bar not saved after wake'
  })),
  {
    scenario: 'sleep-quit-resume',
    check: 'restart',
    step: 'relaunch',
    cause: 'tab bar not saved after wake'
  },
  // A headless host lists a worktree with no saved tab bar (and, after a restart, every worktree)
  // under a synthesized `headless-terminals:` group, while the layout stream names the same group
  // by its saved or minted id: same tabs and order, two group ids. One projection in PR 6.
  {
    scenario: 'headless-*',
    check: 'client',
    detail: /^client group headless-terminals:\S+ is not in the runtime$/,
    cause: 'two group ids'
  },
  {
    scenario: 'headless-*',
    check: 'client',
    detail: /^runtime group \S+ is missing from the client$/,
    cause: 'two group ids'
  },
  // A renamed terminal's title lists as null in terminal.list after an orcad serve restart
  // (session tabs keep it).
  {
    scenario: 'headless-orcad-rename-terminal',
    check: 'expected',
    step: 'rename after restart',
    cause: 'orcad title after restart'
  },
  // A headless reorder saves rows through the session merge door, which keeps the stored row order,
  // so rows and the group disagree. Fixed in PR 6, where rows follow the group's tab order.
  ...(['orcad', 'electron'] as const).map((kind) => ({
    scenario: `headless-${kind}-move-tab-between-groups`,
    check: 'rules' as const,
    rule: 'tab_order_disagrees',
    cause: 'one tab order'
  })),
  // After a headless move into an existing group, paired clients still see that group's previous
  // tab selected, not the moved one. A split into a new group selects the moved tab.
  ...(['orcad', 'electron'] as const).map((kind) => ({
    scenario: `headless-${kind}-move-tab-between-groups`,
    check: 'expected' as const,
    step: 'move',
    detail: /^group \S+ selects /,
    cause: 'headless move-to-group keeps the target group selection'
  }))
]

function covers(
  known: KnownOnMain,
  scenario: string,
  finding: OracleFinding,
  detail: string
): boolean {
  const scenarioMatches = known.scenario.endsWith('*')
    ? scenario.startsWith(known.scenario.slice(0, -1))
    : known.scenario === scenario
  if (!scenarioMatches) {
    return false
  }
  if (known.check !== finding.check) {
    return false
  }
  if (known.transient && !TRANSIENT.test(finding.step)) {
    return false
  }
  if (known.step !== undefined && !finding.step.startsWith(known.step)) {
    return false
  }
  if (known.detail !== undefined && !known.detail.test(detail)) {
    return false
  }
  return known.rule === undefined || detail.startsWith(`${known.rule}:`)
}

/** The findings, reduced to the detail lines no known-on-main entry covers. */
export function unexpectedFindings(
  scenario: string,
  findings: readonly OracleFinding[]
): OracleFinding[] {
  return findings.flatMap((finding) => {
    const details = finding.details.filter(
      (detail) =>
        !LAYOUT_ORACLE_KNOWN_ON_MAIN.some((known) => covers(known, scenario, finding, detail))
    )
    return details.length > 0 ? [{ check: finding.check, step: finding.step, details }] : []
  })
}
