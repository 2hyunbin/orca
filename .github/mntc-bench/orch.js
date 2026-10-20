// Windows-side orchestrator. Usage: node orch.js <phase...>. Env: DISTRO, LIN_NODE, LIN_RG, WIN_RG, PARCEL_WATCHER, OUT.
const { execFileSync, spawn } = require('child_process'), fs = require('fs'), path = require('path')
const { DISTRO, LIN_NODE, LIN_RG, WIN_RG, PARCEL_WATCHER, OUT } = process.env
const OP_TIMEOUT_MIN = +(process.env.OP_TIMEOUT_MIN || 15)
const MNT = '/mnt/c/bench/repo', WIN = 'C:\\bench\\repo', BASE = '/home/orca/bench/base'
const HERE = '/mnt/' + __dirname[0].toLowerCase() + __dirname.slice(2).replace(/\\/g, '/')
fs.mkdirSync(OUT, { recursive: true })
const log = (file, obj) => { fs.appendFileSync(path.join(OUT, file), JSON.stringify(obj) + '\n'); console.log(file, JSON.stringify(obj)) }
const wsl = (args, opts = {}) => execFileSync('wsl.exe', ['-d', DISTRO, ...args], { windowsHide: true, maxBuffer: 1 << 28, ...opts }).toString()
const sh = (cmd, user) => wsl([...(user ? ['-u', user] : []), '--exec', 'bash', '-c', cmd])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function dropCaches() {
  sh('sync; echo 3 > /proc/sys/vm/drop_caches', 'root')
  const rc = execFileSync('pwsh', ['-NoProfile', '-File', path.join(__dirname, 'purge.ps1')], { windowsHide: true }).toString().trim()
  if (rc !== '0') console.log('standby purge status', rc)
}
const PATHS = {
  a: { kind: 'bridge', linuxRepo: MNT }, b: { kind: 'host', linuxRepo: MNT },
  c: { kind: 'win', linuxRepo: MNT }, d: { kind: 'host', linuxRepo: BASE }
}
function ops(p, list, tag, extraCfg = {}) {
  const cfg = Buffer.from(JSON.stringify({ ...PATHS[p], ...extraCfg, winRepo: WIN, distro: DISTRO, linRg: LIN_RG, winRg: WIN_RG, ops: list })).toString('base64')
  const timeout = OP_TIMEOUT_MIN * 60_000
  let out
  try {
    out = PATHS[p].kind === 'host'
      ? wsl(['--exec', LIN_NODE, `${HERE}/ops.js`, cfg], { timeout })
      : execFileSync(process.execPath, [path.join(__dirname, 'ops.js'), cfg], { windowsHide: true, maxBuffer: 1 << 28, timeout }).toString()
  } catch (e) {
    const timedOut = e.code === 'ETIMEDOUT' || e.signal === 'SIGTERM'
    log('results.jsonl', { path: p, tag, ops: list, ...(timedOut ? { timeout: `> ${OP_TIMEOUT_MIN} min` } : { error: String(e.stdout ?? e).slice(0, 600) }) })
    return []
  }
  const r = JSON.parse(out.trim().split('\n').pop())
  if (r.error) { log('results.jsonl', { path: p, tag, ops: list, error: r.error }); return [] }
  for (const x of r) log('results.jsonl', { path: p, tag, ...x })
  return r
}
function coldWarm(p, op, extra = {}, cold = 3, warm = 5) {
  for (let i = 0; i < cold; i++) { dropCaches(); ops(p, [{ op, ...extra, reps: 1 }], 'cold') }
  ops(p, [{ op, ...extra, reps: warm }], 'warm')
}
const winGit = (args) => execFileSync('git', args, { cwd: WIN, windowsHide: true, maxBuffer: 1 << 28 }).toString()
const linGit = (args, repo = MNT) => wsl(['--exec', '/usr/bin/env', 'GIT_OPTIONAL_LOCKS=0', '/usr/bin/git', '-C', repo, ...args])
const t0 = () => performance.now(), since = (t) => Math.round(performance.now() - t)

const PHASES = {
  // Unflagged WSL git on a Windows-written CRLF index: what the bridge does today.
  async plain() {
    dropCaches(); ops('b', [{ op: 'status', reps: 1 }], 'plain-cold'); ops('b', [{ op: 'status', reps: 2 }], 'plain-warm')
    dropCaches(); ops('a', [{ op: 'status', reps: 1 }], 'plain-cold'); ops('a', [{ op: 'status', reps: 1 }], 'plain-warm')
  },
  async status() {
    for (const p of ['b', 'a']) coldWarm(p, 'status', { r23: true })
    coldWarm('c', 'status'); coldWarm('d', 'status')
  },
  async fsops() {
    for (const op of ['readdir', 'read5mb', 'search']) for (const p of ['a', 'b', 'c', 'd']) coldWarm(p, op)
    coldWarm('a', 'search', { legacy: true })
    ops('a', [{ op: 'readdir', reps: 3 }, { op: 'read5mb', reps: 3 }], 'unc-wsl$', { uncHost: 'wsl$' })
  },
  async lineendings() {
    // R23b: same-size Windows edit with a preserved mtime.
    const rel = 'pkgs/p05/e/m7.ts', file = path.join(WIN, ...rel.split('/'))
    const st = fs.statSync(file), body = fs.readFileSync(file, 'utf8')
    fs.writeFileSync(file, body.replace('export', 'exporT')); fs.utimesSync(file, st.atime, st.mtime)
    const sameSize = fs.statSync(file).size === st.size
    const listed = (out) => out.split('\n').some((l) => l.includes(rel))
    let t = t0(); const minimal = linGit(['-c', 'core.autocrlf=true', '-c', 'core.checkStat=minimal', 'status', '--porcelain=v2', '--untracked-files=all']); const minimalMs = since(t)
    t = t0(); const suspect = linGit(['-c', 'core.autocrlf=true', 'status', '--porcelain=v2', '--', rel]); const suspectMs = since(t)
    const suspects = (n) => Array.from({ length: n }, (_, i) => `pkgs/p06/${'abcdefghij'[i % 10]}/m${Math.floor(i / 10)}.ts`)
    t = t0(); linGit(['-c', 'core.autocrlf=true', 'status', '--porcelain=v2', '--', rel, ...suspects(19)]); const suspect20Ms = since(t)
    t = t0(); linGit(['-c', 'core.autocrlf=true', 'status', '--porcelain=v2', '--', rel, ...suspects(199)]); const suspect200Ms = since(t)
    const windows = winGit(['status', '--porcelain=v2'])
    log('lineendings.jsonl', { test: 'r23b-same-size-preserved-mtime', sameSize, minimalSees: listed(minimal), minimalMs, suspectRecheckSees: listed(suspect), suspectMs, suspect20Ms, suspect200Ms, windowsGitSees: listed(windows) })
    winGit(['checkout', '--', rel])
    // Staging through WSL git: unflagged (the bridge today) vs the R23 flags.
    for (const [label, flags] of [['unflagged', []], ['r23', ['-c', 'core.autocrlf=true', '-c', 'core.checkStat=minimal']]]) {
      const f = `pkgs/p07/f/m${label === 'r23' ? 9 : 8}.ts`
      fs.appendFileSync(path.join(WIN, ...f.split('/')), `// ${label}\r\n`)
      sh(`cd ${MNT} && git ${flags.join(' ')} add -- ${f} && git -c user.name=b -c user.email=b@x commit -q --no-verify -m ${label}`)
      const blob = sh(`cd ${MNT} && git cat-file -p HEAD:${f}`)
      const otherStatus = winGit(['status', '--porcelain=v2']).split('\n').filter(Boolean).length
      log('lineendings.jsonl', { test: 'wsl-commit-of-crlf-file', label, blobHasCR: blob.includes('\r'), windowsStatusEntriesAfter: otherStatus, windowsDiffStatHead: winGit(['diff', '--stat', 'HEAD~1', 'HEAD']).trim().split('\n').pop() })
    }
    winGit(['reset', '-q', '--hard', 'HEAD~2'])
  },
  async watcher() {
    const child = spawn('wsl.exe', ['-d', DISTRO, '--exec', '/usr/bin/env', `PARCEL_WATCHER=${PARCEL_WATCHER}`, 'WATCH_SECONDS=150', LIN_NODE, `${HERE}/watch.js`, MNT, BASE], { windowsHide: true })
    const events = []; let ready = 0; let buf = ''
    child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const e = JSON.parse(l); if (e.ready) { ready++; log('watch.jsonl', e) } else events.push(e) } catch {} } })
    for (let i = 0; i < 600 && ready < 2; i++) await sleep(100)
    await sleep(1000)
    const prune = "\\( -type d \\( -name '.git' -o -name 'node_modules' \\) -prune \\) -o"
    const snapshot = () => { const t = t0(); const out = sh(`find ${MNT} -mindepth 1 -maxdepth 2 ${prune} -printf '%y\\t%T@\\t%p\\0'`); return { ms: since(t), map: new Map(out.split('\0').filter(Boolean).map((e) => { const [y, m, p] = e.split('\t'); return [p, m] })) } }
    const actions = [
      ['windows-modify-depth4', () => fs.appendFileSync(path.join(WIN, 'pkgs', 'p03', 'c', 'm5.ts'), '// w\r\n'), `${MNT}/pkgs/p03/c/m5.ts`],
      ['windows-create-depth4', () => fs.writeFileSync(path.join(WIN, 'pkgs', 'p03', 'c', 'new-win.ts'), 'x\r\n'), `${MNT}/pkgs/p03/c/new-win.ts`],
      ['windows-create-depth2', () => fs.writeFileSync(path.join(WIN, 'assets', 'new-win.txt'), 'x\r\n'), `${MNT}/assets/new-win.txt`],
      ['windows-modify-depth1', () => fs.appendFileSync(path.join(WIN, 'README.md'), 'w\r\n'), `${MNT}/README.md`],
      ['wsl-modify-depth4-mntc', () => sh(`echo w >> ${MNT}/pkgs/p04/d/m6.ts`), `${MNT}/pkgs/p04/d/m6.ts`],
      ['wsl-modify-depth4-ext4', () => sh(`echo w >> ${BASE}/pkgs/p04/d/m6.ts`), `${BASE}/pkgs/p04/d/m6.ts`]
    ]
    for (const [name, act, target] of actions) {
      const before = snapshot(); const at = Date.now(); act(); await sleep(4000)
      const after = snapshot()
      const changed = [...after.map].filter(([p, m]) => before.map.get(p) !== m).map(([p]) => p)
      const hit = events.filter((e) => e.at >= at && e.path === target && e.src === 'parcel')
      const raw = events.filter((e) => e.at >= at && e.path === target && e.src === 'fswatch')
      log('watch.jsonl', { action: name, inotifySaw: hit.length > 0, rawFsWatchSaw: target.startsWith(MNT) && (target.includes('/p03/c/') || target.includes('/p04/d/')) ? raw.length > 0 : 'n/a', latencyMs: hit.length ? hit[0].at - at : null, eventTypes: hit.map((e) => e.type), bridgePollSaw: target.startsWith(MNT) ? changed.length > 0 : 'n/a', bridgePollChanged: changed, bridgePollMs: after.ms })
    }
    child.kill()
    winGit(['checkout', '--', '.']); winGit(['clean', '-fdq'])
  },
  async writes() {
    ops('b', [{ op: 'stage', r23: true, reps: 5 }, { op: 'commit', r23: true, reps: 3 }, { op: 'diff', r23: true, reps: 5 }], 'write')
    ops('c', [{ op: 'status', reps: 1 }], 'after-wsl-index-write'); ops('c', [{ op: 'status', reps: 3 }], 'warm-after-wsl-write')
    ops('c', [{ op: 'stage', reps: 5 }, { op: 'commit', reps: 5 }, { op: 'diff', reps: 5 }], 'write')
    ops('b', [{ op: 'status', r23: true, reps: 1 }], 'after-win-index-write'); ops('b', [{ op: 'status', r23: true, reps: 3 }], 'warm-after-win-write')
    ops('a', [{ op: 'status', reps: 1 }], 'plain-after-wsl-index-write')
    ops('a', [{ op: 'stage', r23: true, reps: 5 }, { op: 'commit', r23: true, reps: 3 }, { op: 'diff', r23: true, reps: 5 }], 'write')
    ops('d', [{ op: 'stage', reps: 5 }, { op: 'commit', reps: 5 }, { op: 'diff', reps: 5 }], 'write')
  }
}
;(async () => {
  for (const ph of process.argv.slice(2)) { const t = t0(); console.log('== phase', ph); await PHASES[ph](); log('phases.jsonl', { phase: ph, ms: since(t) }) }
})().catch((e) => { console.error(e); process.exit(1) })
