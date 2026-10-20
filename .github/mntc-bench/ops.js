// Runs benchmark ops in-process; argv[2] = JSON {kind, linuxRepo, winRepo, ops}. Prints JSON results.
// kind: 'bridge' (Windows node -> wsl.exe per op, UNC fs), 'host' (node inside the distro, as orcad), 'win' (git.exe on C:\)
const { execFile } = require('child_process'), fs = require('fs'), path = require('path')
const cfg = JSON.parse(Buffer.from(process.argv[2], 'base64').toString())
const DISTRO = cfg.distro
const LOCALE = ['LANGUAGE=en', 'LC_ALL=en_US.UTF-8', 'LANG=en_US.UTF-8']
const R23 = ['-c', 'core.autocrlf=true', '-c', 'core.checkStat=minimal']
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
function run(bin, args, opts = {}) {
  return new Promise((res, rej) => execFile(bin, args, { maxBuffer: 1 << 29, windowsHide: true, ...opts }, (e, out, err) => {
    if (e && !opts.okCodes?.includes(e.code)) rej(new Error(`${bin} ${args.join(' ')}: ${e.message} ${err}`)); else res(out)
  }))
}
function git(args, { status = false, r23 = false } = {}) {
  const a = [...(r23 ? R23 : []), ...args]
  if (cfg.kind === 'win') return run('git', a, { cwd: cfg.winRepo, env: { ...process.env, ...(status ? { GIT_OPTIONAL_LOCKS: '0' } : {}) } })
  if (cfg.kind === 'host') return run('/usr/bin/git', a, { cwd: cfg.linuxRepo, env: { ...process.env, LANGUAGE: 'en', LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8', ...(status ? { GIT_OPTIONAL_LOCKS: '0' } : {}) } })
  // Bridge: status uses the direct-git env form, writes the bash -c form (src/main/git/command-runner/wsl-command-resolution.ts).
  if (status) return run('wsl.exe', ['-d', DISTRO, '--exec', '/usr/bin/env', 'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/home/orca', ...LOCALE, 'GIT_OPTIONAL_LOCKS=0', '/usr/bin/git', '-C', cfg.linuxRepo, ...a], { cwd: 'C:\\Windows' })
  return run('wsl.exe', ['-d', DISTRO, '--exec', 'bash', '-c', `cd ${q(cfg.linuxRepo)} && ${LOCALE.join(' ')} git ${a.map(q).join(' ')}`], { cwd: 'C:\\Windows' })
}
const fsRoot = cfg.kind === 'bridge' ? `\\\\wsl.localhost\\${DISTRO}${cfg.linuxRepo.replace(/\//g, '\\')}` : cfg.kind === 'win' ? cfg.winRepo : cfg.linuxRepo
const P = (rel) => path.join(fsRoot, ...rel.split('/'))
const EOL = cfg.kind === 'host' && !cfg.linuxRepo.startsWith('/mnt/') ? '\n' : '\r\n'
let seq = Date.now()
const OPS = {
  status: async (o) => { const out = await git(['-c', 'core.quotePath=false', 'status', '--porcelain=v2', '--branch', '--untracked-files=all'], { status: true, r23: o.r23 }); return { entries: out.split('\n').filter((l) => l && !l.startsWith('#')).length } },
  stage: async (o) => { fs.appendFileSync(P('pkgs/p00/a/m1.ts'), `// edit ${seq++}${EOL}`); const t = performance.now(); await git(['add', '--', 'pkgs/p00/a/m1.ts'], { r23: o.r23 }); return { ms: performance.now() - t } },
  commit: async (o) => { await git(['-c', 'user.name=bench', '-c', 'user.email=b@x', 'commit', '-q', '--no-verify', '-m', `bench ${seq++}`], { r23: o.r23 }); return {} },
  diff: async (o) => { const f = 'pkgs/p01/b/m2.ts'; fs.appendFileSync(P(f), `// d ${seq++}${EOL}`); const t = performance.now(); const out = await git(['diff', '--no-ext-diff', '--', f], { r23: o.r23 }); const ms = performance.now() - t; await git(['checkout', '--', f], { r23: o.r23 }); return { ms, lines: out.split('\n').length } },
  readdir: async () => ({ entries: (await fs.promises.readdir(P('src/big'), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name)).length }),
  read5mb: async () => ({ bytes: (await fs.promises.readFile(P('assets/big.txt'))).length }),
  search: async (o) => {
    const args = ['--json', '--fixed-strings', '--ignore-case', 'ORCA_NEEDLE', '.']
    let out
    if (cfg.kind === 'host') out = await run(cfg.linRg, args, { cwd: cfg.linuxRepo, okCodes: [1] })
    else if (o.legacy) out = await run('wsl.exe', ['-d', DISTRO, '--exec', 'bash', '-c', `cd ${q(cfg.linuxRepo)} && ${q(cfg.linRg)} ${args.map(q).join(' ')}`], { cwd: 'C:\\Windows', okCodes: [1] })
    else out = await run(cfg.winRg, args, { cwd: cfg.winRepo, okCodes: [1] }) // the bridge searches drive paths with host rg (#27690)
    return { matches: out.split('\n').filter((l) => l.includes('"type":"match"')).length }
  }
}
;(async () => {
  const results = []
  for (const o of cfg.ops) {
    const times = []; let info
    for (let i = 0; i < (o.reps ?? 1); i++) {
      const t = performance.now(); const r = await OPS[o.op](o); const total = performance.now() - t
      times.push(Math.round(r.ms ?? total)); delete r.ms; info = r
    }
    results.push({ ...o, kind: cfg.kind, times, info })
  }
  console.log(JSON.stringify(results))
})().catch((e) => { console.log(JSON.stringify({ error: String(e) })); process.exit(1) })
