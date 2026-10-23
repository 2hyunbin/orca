/**
 * `--reclaim-stale-lock`: the explicit recovery for an orcad instance lock that no automatic start
 * may judge, such as one on a shared home after a reboot (#32177). Dependency-free so the CLI,
 * orcad's launcher and clients can all name it.
 */
export const ORCAD_RECLAIM_STALE_LOCK_FLAG = '--reclaim-stale-lock'
export const ORCAD_RECLAIM_STALE_LOCK_COMMAND = `orca serve ${ORCAD_RECLAIM_STALE_LOCK_FLAG}`
