// Why: Git 2.29 can auto-run commit-graph work before maintenance.auto became a gate.
// The other keys cover modern maintenance and legacy auto-gc without changing user config.
// Orca owns the replacement: idle ref, pack and loose-object maintenance (repo-ref-maintenance).
export const GIT_FETCH_SKIP_AUTO_MAINTENANCE_CONFIG_ARGS = [
  '-c',
  'maintenance.auto=false',
  '-c',
  'maintenance.commit-graph.auto=0',
  '-c',
  'gc.auto=0'
] as const
