/**
 * The host's own download of the pinned Node archive, tried only when this computer couldn't
 * produce it: many networks give the host a route, or a proxy in its environment, that the
 * desktop lacks. The archive hash is checked here and the promote re-checks the executable, so
 * where the bytes came from never decides what is accepted.
 */
import { copyFile, link, mkdtemp } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { NODE_DIST_MIRROR_ENV_KEYS, nodeDistMirrorUrl } from '../../../shared/node-dist-mirror'
import {
  NODE_RUNTIME_PIN,
  nodeRuntimeReleaseUrl,
  pinnedNodeRuntimeAsset,
  type NodeRuntimeTarget
} from '../../../shared/node-runtime-pin'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import {
  parseRemoteRuntimeExitReport,
  REMOTE_NODE_RUNTIME_EXIT_PREFIX
} from '../../ssh/orcad-remote-node-runtime-report'
import {
  isWindowsRemoteHost,
  joinRemotePath,
  type RemoteHostPlatform
} from '../../ssh/ssh-remote-platform'
import { configuredNodeDistMirror } from '../../node-runtime/node-dist-mirror-setting'
import { remoteSha256Command } from './remote-sha256-command'

export const HOST_NODE_DOWNLOAD_OK = 'ORCA_NODE_HOST_DOWNLOAD_OK'
export const HOST_NODE_DOWNLOAD_FAILED = 'ORCA_NODE_HOST_DOWNLOAD_FAILED'
export const HOST_NODE_DOWNLOAD_NO_TOOL = 'ORCA_NODE_HOST_DOWNLOAD_NO_TOOL'
/** One wall-clock budget for every URL and tool: ~70 KB/s still fetches the ~58 MB archive. */
const HOST_DOWNLOAD_BUDGET_SECONDS = 840
/** Below this a new attempt can't finish, so the loop stops and reports instead. */
const HOST_DOWNLOAD_MIN_ATTEMPT_SECONDS = 30
/** The budget plus the hash and the report, so the script always answers before the exec gives up. */
export const HOST_NODE_DOWNLOAD_TIMEOUT_MS = (HOST_DOWNLOAD_BUDGET_SECONDS + 120) * 1000

const HOST_NODE_DOWNLOAD_NOT_PINNED =
  'the file is not the pinned release (a proxy or filter may have replaced it, or the host lacks sha256sum and shasum)'

export function hostNodeRuntimeUrl(target: NodeRuntimeTarget): string {
  const asset = pinnedNodeRuntimeAsset(target)
  return nodeRuntimeReleaseUrl(asset.source, asset.archive)
}

/**
 * Downloads into the installer's stage, trying this computer's configured mirror, then the
 * host's own mirror variable, then the release URL; curl first, else wget. Keeps the file only if
 * it hashes to the pin, and always exits 0 with a marker so the caller gets the tools' own words.
 */
export function hostDownloadNodeRuntimeCommand(
  host: RemoteHostPlatform,
  args: { stageDir: string; target: NodeRuntimeTarget; mirror?: string | null }
): string {
  const asset = pinnedNodeRuntimeAsset(args.target)
  const file = quotePosixShell(joinRemotePath(host, args.stageDir, asset.archive))
  // Mirrors carry the official tree only; unofficial builds live at one address.
  const official = asset.source === 'official'
  const urls = [
    official && args.mirror
      ? quotePosixShell(nodeDistMirrorUrl(args.mirror, NODE_RUNTIME_PIN.version, asset.archive))
      : null,
    official
      ? `"\${orca_dl_mirror:+$orca_dl_mirror/v${NODE_RUNTIME_PIN.version}/${asset.archive}}"`
      : null,
    quotePosixShell(hostNodeRuntimeUrl(args.target))
  ].filter((url): url is string => url !== null)
  const curl = `curl -fsSL --connect-timeout 20 --max-time "$orca_dl_t" -o ${file} "$orca_dl_url"`
  const wget = `$orca_dl_timeout wget -q -T 20 -t 2 -O ${file} "$orca_dl_url"`
  const hostMirror = NODE_DIST_MIRROR_ENV_KEYS.reduceRight(
    (fallback, key) => `\${${key}:-${fallback}}`,
    ''
  )
  const min = HOST_DOWNLOAD_MIN_ATTEMPT_SECONDS
  // Without a clock each of the (up to) two tools per URL gets an equal share of the budget.
  const share = Math.floor(HOST_DOWNLOAD_BUDGET_SECONDS / (2 * urls.length))
  return [
    'orca_dl_status=127; orca_dl_out=; orca_dl_ok=; orca_dl_t=',
    `orca_dl_mirror="${hostMirror}"; orca_dl_mirror="\${orca_dl_mirror%/}"`,
    // One deadline for the whole loop, so an unreachable mirror can't starve the release URL.
    'orca_dl_end=$(date +%s 2>/dev/null)',
    `case "$orca_dl_end" in ''|*[!0-9]*) orca_dl_end= ;; *) orca_dl_end=$((orca_dl_end + ${HOST_DOWNLOAD_BUDGET_SECONDS})) ;; esac`,
    `orca_dl_left() { if [ -n "$orca_dl_end" ]; then orca_dl_t=$((orca_dl_end - $(date +%s))); else orca_dl_t=${share}; fi; [ "$orca_dl_t" -ge ${min} ]; }`,
    // wget has no total-time limit of its own. Probed by running it: old busybox wants `-t SECS`.
    'orca_dl_timeout=; timeout 5 true >/dev/null 2>&1 && orca_dl_timeout=timeout',
    `for orca_dl_url in ${urls.join(' ')}; do`,
    '[ -n "$orca_dl_url" ] || continue',
    `orca_dl_left || { orca_dl_out="$orca_dl_out\${orca_dl_out:+; }$orca_dl_url: not tried, out of time"; break; }`,
    'orca_dl_try=127; orca_dl_said=',
    `if command -v curl >/dev/null 2>&1; then orca_dl_said=$(${curl} 2>&1); orca_dl_try=$?; fi`,
    // Why wget after a failed curl: a curl built without TLS or proxy support can fail where wget works.
    'if [ "$orca_dl_try" != 0 ] && command -v wget >/dev/null 2>&1 && orca_dl_left; then ' +
      '[ -n "$orca_dl_timeout" ] && orca_dl_timeout="timeout $orca_dl_t"; ' +
      `orca_dl_said="$orca_dl_said\${orca_dl_said:+; }$(${wget} 2>&1)"; orca_dl_try=$?; fi`,
    'if [ "$orca_dl_try" = 127 ] && [ -z "$orca_dl_said" ]; then break; fi',
    'orca_dl_status=$orca_dl_try',
    `if [ "$orca_dl_try" = 0 ] && [ "$(${remoteSha256Command(file)})" = ${quotePosixShell(asset.archiveSha256)} ]; then orca_dl_ok=1; break; fi`,
    `rm -f ${file}`,
    `[ "$orca_dl_try" = 0 ] && orca_dl_said='${HOST_NODE_DOWNLOAD_NOT_PINNED}'`,
    'orca_dl_out="$orca_dl_out${orca_dl_out:+; }$orca_dl_url: $orca_dl_said"',
    'done',
    `if [ -n "$orca_dl_ok" ]; then echo ${HOST_NODE_DOWNLOAD_OK}`,
    `elif [ "$orca_dl_status" = 127 ] && [ -z "$orca_dl_out" ]; then echo ${HOST_NODE_DOWNLOAD_NO_TOOL}`,
    `else echo ${HOST_NODE_DOWNLOAD_FAILED}; echo "${REMOTE_NODE_RUNTIME_EXIT_PREFIX}$orca_dl_status"; ` +
      `printf '%s' "$orca_dl_out" | head -c 3000; fi`
  ].join('\n')
}

export type HostNodeDownloadResult = { ok: true } | { ok: false; report: string }

/** Whether the archive is now in the stage; otherwise the host's reason, in plain words. */
export function readHostNodeDownload(output: string): HostNodeDownloadResult {
  const lines = output.trim().split(/\r?\n/)
  if (lines.at(-1)?.trim() === HOST_NODE_DOWNLOAD_OK) {
    return { ok: true }
  }
  if (lines.some((line) => line.trim() === HOST_NODE_DOWNLOAD_NO_TOOL)) {
    return { ok: false, report: 'it has neither curl nor wget' }
  }
  const failed = output.indexOf(HOST_NODE_DOWNLOAD_FAILED)
  if (failed !== -1) {
    const { exitStatus, output: words } = parseRemoteRuntimeExitReport(output.slice(failed))
    return {
      ok: false,
      report: `its download failed${exitStatus ? ` (exit ${exitStatus})` : ''}${words ? `: ${words}` : ''}`
    }
  }
  return { ok: false, report: `it gave an unexpected reply: ${output.trim().slice(0, 500)}` }
}

/** Neither this computer nor the host could get the pinned archive; says what is left to try. */
export class NodeRuntimeUnreachableError extends Error {
  constructor(
    readonly url: string,
    readonly hostReport: string,
    readonly offlineArchivePath: string | undefined,
    cause: unknown,
    mirrorable = true
  ) {
    const desktop = cause instanceof Error ? cause.message : String(cause)
    const mirror = mirrorable
      ? ', set a mirror of nodejs.org/dist in Settings > Advanced > Network > Node.js download mirror ' +
        '(or NODEJS_ORG_MIRROR on the host)'
      : ''
    const offline = offlineArchivePath
      ? `, or download that file on another machine and copy it to ${offlineArchivePath} on this computer.`
      : '.'
    super(
      `Neither this computer nor the host could download Node from ${url}. ` +
        `This computer: ${desktop}. The host: ${hostReport}. ` +
        `Check the network or proxy on either machine and connect again${mirror}${offline}`,
      { cause }
    )
    this.name = 'NodeRuntimeUnreachableError'
  }
}

/**
 * Runs the host download after this computer's attempt failed with `desktopError`, and returns the
 * archive's name in the stage; throws one error naming both attempts when the host fails too.
 */
export async function downloadNodeRuntimeOnHost(args: {
  exec: (command: string, options: { signal?: AbortSignal; timeoutMs?: number }) => Promise<string>
  host: RemoteHostPlatform
  stageDir: string
  target: NodeRuntimeTarget
  desktopError: unknown
  offlineArchivePath?: string
  timeoutMs: number
  signal?: AbortSignal
}): Promise<string> {
  const output = await args.exec(
    hostDownloadNodeRuntimeCommand(args.host, {
      stageDir: args.stageDir,
      target: args.target,
      mirror: configuredNodeDistMirror()
    }),
    { signal: args.signal, timeoutMs: args.timeoutMs }
  )
  const result = readHostNodeDownload(output)
  if (!result.ok) {
    throw new NodeRuntimeUnreachableError(
      hostNodeRuntimeUrl(args.target),
      result.report,
      args.offlineArchivePath,
      args.desktopError,
      pinnedNodeRuntimeAsset(args.target).source === 'official'
    )
  }
  console.warn(
    `[orcad] This computer couldn't download Node, so the host downloaded it: ${String(args.desktopError)}`
  )
  return pinnedNodeRuntimeAsset(args.target).archive
}

/**
 * Puts the pinned archive in the host stage: this computer's verified copy, uploaded, or else the
 * host's own download. Returns the archive's name there.
 */
export async function stageNodeRuntimeArchive(args: {
  host: RemoteHostPlatform
  target: NodeRuntimeTarget
  stageDir: string
  archivePath: () => Promise<string>
  offlineArchivePath?: string
  exec: (command: string, options: { signal?: AbortSignal; timeoutMs?: number }) => Promise<string>
  upload: (localDir: string) => Promise<void>
  /** Receives the local upload directory as soon as it exists, so the caller can remove it. */
  onLocalStage: (localDir: string) => void
  signal?: AbortSignal
}): Promise<{ archive: string }> {
  let archivePath: string
  try {
    archivePath = await args.archivePath()
  } catch (desktopError) {
    // Why any failure: a proxy's block page fails the hash just as a refused connect fails.
    if (isWindowsRemoteHost(args.host) || args.signal?.aborted) {
      throw desktopError
    }
    return {
      archive: await downloadNodeRuntimeOnHost({
        ...args,
        desktopError,
        timeoutMs: HOST_NODE_DOWNLOAD_TIMEOUT_MS
      })
    }
  }
  const uploadDir = await mkdtemp(join(dirname(archivePath), '.runtime-upload-'))
  args.onLocalStage(uploadDir)
  const archive = basename(archivePath)
  await link(archivePath, join(uploadDir, archive)).catch(() =>
    copyFile(archivePath, join(uploadDir, archive))
  )
  await args.upload(uploadDir)
  return { archive }
}
