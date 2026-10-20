import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runProcessSync } from '@orca/process-host'
import { NODE_RUNTIME_ASSETS, NODE_RUNTIME_PIN } from '../../../shared/node-runtime-pin'
import { getRemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import {
  hostDownloadNodeRuntimeCommand,
  hostNodeRuntimeUrl,
  readHostNodeDownload
} from './remote-node-runtime-host-download'

const TARGET = 'linux-x64-glibc'
const host = getRemoteHostPlatform('linux-x64')
const PAYLOAD = 'pinned node archive bytes'
const originalAsset = { ...NODE_RUNTIME_ASSETS[TARGET] }
const directories: string[] = []

beforeEach(() => {
  Object.assign(NODE_RUNTIME_ASSETS[TARGET], {
    archiveSha256: createHash('sha256').update(PAYLOAD).digest('hex')
  })
})
afterEach(() => {
  Object.assign(NODE_RUNTIME_ASSETS[TARGET], originalAsset)
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function which(tool: string): string | null {
  const result = runProcessSync({ program: '/bin/sh', args: ['-c', `command -v ${tool}`] })
  return result.code === 0 ? result.stdout.trim() : null
}

/** A host whose PATH holds only the shell basics plus the given download-tool shims. */
function fakeHost(tools: Record<string, string>): { bin: string; stage: string } {
  const root = mkdtempSync(join(tmpdir(), 'orca-host-download-'))
  directories.push(root)
  const bin = join(root, 'bin')
  const stage = join(root, 'stage')
  mkdirSync(bin)
  mkdirSync(stage)
  for (const basic of ['cut', 'rm', 'head', 'sha256sum', 'shasum', 'perl']) {
    const resolved = which(basic)
    if (resolved) {
      symlinkSync(resolved, join(bin, basic))
    }
  }
  for (const [name, body] of Object.entries(tools)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  }
  return { bin, stage }
}

// Writes `$1` to the file after the given output flag, wherever it appears in argv.
const writeTo = (flag: string, content: string): string =>
  `while [ $# -gt 0 ]; do if [ "$1" = ${flag} ]; then printf '%s' '${content}' > "$2"; fi; shift; done`

function runOnHost(
  bin: string,
  stage: string,
  options: { mirror?: string; env?: Record<string, string> } = {}
): string {
  const command = hostDownloadNodeRuntimeCommand(host, {
    stageDir: stage,
    target: TARGET,
    mirror: options.mirror
  })
  const result = runProcessSync({
    program: '/bin/sh',
    args: ['-c', command],
    env: { PATH: bin, ...options.env },
    timeoutMs: 30_000
  })
  expect(result.code, result.stderr).toBe(0)
  return result.stdout
}

describe.skipIf(process.platform === 'win32')('the host-side pinned Node download', () => {
  it('downloads the pinned URL with curl and keeps the verified archive', () => {
    const { bin, stage } = fakeHost({
      curl: `echo "$@" > "\${0%/*}/curl.args"\n${writeTo('-o', PAYLOAD)}`
    })
    expect(readHostNodeDownload(runOnHost(bin, stage))).toEqual({ ok: true })
    expect(existsSync(join(stage, originalAsset.archive))).toBe(true)
    expect(
      runProcessSync({ program: '/bin/cat', args: [join(bin, 'curl.args')] }).stdout
    ).toContain(hostNodeRuntimeUrl(TARGET))
  })

  it('falls back to wget when curl fails', () => {
    const { bin, stage } = fakeHost({
      curl: "echo 'curl: (35) TLS connect error' >&2; exit 35",
      wget: writeTo('-O', PAYLOAD)
    })
    expect(readHostNodeDownload(runOnHost(bin, stage))).toEqual({ ok: true })
  })

  it('moves on to the release URL when a mirror times out from the host', () => {
    const { bin, stage } = fakeHost({
      curl:
        `for a in "$@"; do case "$a" in https://nodejs.org/*) ${writeTo('-o', PAYLOAD)}; exit 0;; esac; done\n` +
        "echo 'curl: (28) Connection timed out after 20001 milliseconds' >&2; exit 28"
    })
    expect(
      readHostNodeDownload(runOnHost(bin, stage, { mirror: 'https://desk.example/dist' }))
    ).toEqual({
      ok: true
    })
  })

  it('splits the deadline over the URLs left, so a stalled mirror leaves time for the release', () => {
    const { bin, stage } = fakeHost({
      date: 'echo 1000',
      curl:
        `prev=; for a in "$@"; do [ "$prev" = --max-time ] && echo "$a" >> "\${0%/*}/max-times"; prev=$a; done\n` +
        `ulimit -f >> "\${0%/*}/file-limit"\n` +
        `for a in "$@"; do case "$a" in https://nodejs.org/*) ${writeTo('-o', PAYLOAD)}; exit 0;; esac; done\n` +
        "echo 'curl: (28) Operation timed out' >&2; exit 28"
    })
    const output = runOnHost(bin, stage, { mirror: 'https://desk.example/dist' })
    expect(readHostNodeDownload(output)).toEqual({ ok: true })
    const read = (name: string): string[] =>
      runProcessSync({ program: '/bin/cat', args: [join(bin, name)] })
        .stdout.trim()
        .split('\n')
    expect(read('max-times')).toEqual(['420', '840'])
    // 200 MiB in 512-byte blocks: an endless response can't fill the host's disk.
    expect(read('file-limit')[0]).toBe('409600')
  })

  it('stops starting downloads once the shared deadline has passed', () => {
    // The first reading sets the deadline; every later one is already past it.
    const { bin, stage } = fakeHost({
      date: `if [ -e "\${0%/*}/clock" ]; then echo 99999; else : > "\${0%/*}/clock"; echo 1000; fi`,
      curl: `touch "\${0%/*}/curl.ran"; exit 7`
    })
    const result = readHostNodeDownload(runOnHost(bin, stage))
    expect(result).toMatchObject({ ok: false, report: expect.stringContaining('out of time') })
    expect(existsSync(join(bin, 'curl.ran'))).toBe(false)
  })

  it('discards a file that is not the pinned release', () => {
    const { bin, stage } = fakeHost({ curl: writeTo('-o', '<html>blocked by policy</html>') })
    const result = readHostNodeDownload(runOnHost(bin, stage))
    expect(result).toMatchObject({ ok: false, report: expect.stringContaining('pinned release') })
    expect(existsSync(join(stage, originalAsset.archive))).toBe(false)
  })

  it("reports the tool's own words when every download fails", () => {
    const { bin, stage } = fakeHost({
      curl: "echo 'curl: (7) Failed to connect to nodejs.org port 443' >&2; exit 7"
    })
    const result = readHostNodeDownload(runOnHost(bin, stage))
    expect(result).toEqual({
      ok: false,
      report: `its download failed (exit 7): ${hostNodeRuntimeUrl(TARGET)}: curl: (7) Failed to connect to nodejs.org port 443`
    })
  })

  // Records each URL, and serves only the one whose prefix is given.
  const curlServing = (prefix: string): string =>
    `for a in "$@"; do case "$a" in http*) echo "$a" >> "\${0%/*}/urls";; esac; done\n` +
    `for a in "$@"; do case "$a" in ${prefix}*) ${writeTo('-o', PAYLOAD)}; exit 0;; esac; done\n` +
    "echo 'curl: (22) The requested URL returned error: 404' >&2; exit 22"
  const urlsTried = (bin: string): string[] =>
    runProcessSync({ program: '/bin/cat', args: [join(bin, 'urls')] })
      .stdout.trim()
      .split('\n')
  const mirrored = (base: string): string =>
    `${base}/v${NODE_RUNTIME_PIN.version}/${originalAsset.archive}`

  it("tries this computer's mirror first and stops once it serves the pinned file", () => {
    const { bin, stage } = fakeHost({ curl: curlServing('https://desk.example/') })
    expect(
      readHostNodeDownload(runOnHost(bin, stage, { mirror: 'https://desk.example/dist' }))
    ).toEqual({ ok: true })
    expect(urlsTried(bin)).toEqual([mirrored('https://desk.example/dist')])
  })

  it("uses the host's NODEJS_ORG_MIRROR, then the release URL", () => {
    const { bin, stage } = fakeHost({ curl: curlServing('https://nodejs.org/') })
    const output = runOnHost(bin, stage, {
      mirror: 'https://desk.example/dist',
      env: { NODEJS_ORG_MIRROR: 'https://host.example/dist/' }
    })
    expect(readHostNodeDownload(output)).toEqual({ ok: true })
    expect(urlsTried(bin)).toEqual([
      mirrored('https://desk.example/dist'),
      mirrored('https://host.example/dist'),
      hostNodeRuntimeUrl(TARGET)
    ])
  })

  it('says so when the host has neither curl nor wget', () => {
    const { bin, stage } = fakeHost({})
    expect(readHostNodeDownload(runOnHost(bin, stage))).toEqual({
      ok: false,
      report: 'it has neither curl nor wget'
    })
  })
})
