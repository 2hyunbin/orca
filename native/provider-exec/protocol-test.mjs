import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import {
  openSync,
  closeSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  chmodSync,
  readFileSync
} from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
const binary = process.argv[2]
assert(binary?.startsWith('/'))
const dir = mkdtempSync(join(process.cwd(), 'gate-contract-'))
let held = openSync(join(dir, 'hold'), 'wx+', 0o600)
const owned = []
const watchers = []
const result = { platform: process.platform, node: process.version, cases: [], roots: [], watchers }
const bound = (promise, label, ms = 7000) => {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), ms)
    })
  ]).finally(() => clearTimeout(timer))
}
const records = (stream) => {
  let buffer = '',
    ended = false
  const queue = [],
    waiters = []
  const push = (value) => (waiters.length ? waiters.shift()(value) : queue.push(value))
  stream
    .setEncoding('utf8')
    .on('data', (chunk) => {
      buffer += chunk
      for (;;) {
        const at = buffer.indexOf('\n')
        if (at === -1) {
          break
        }
        push(buffer.slice(0, at))
        buffer = buffer.slice(at + 1)
      }
    })
    .on('end', () => {
      ended = true
      while (waiters.length) {
        waiters.shift()(null)
      }
    })
  stream.on('error', () => {})
  return () =>
    queue.length
      ? Promise.resolve(queue.shift())
      : ended
        ? Promise.resolve(null)
        : new Promise((resolve) => waiters.push(resolve))
}
const start = async (args, env = process.env) => {
  const nonce = randomBytes(12).toString('hex')
  const child = spawn(binary, ['gate', nonce, ...args], {
    detached: true,
    env,
    stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe', held]
  })
  assert(child.pid > 1)
  owned.push(child)
  result.roots.push(child.pid)
  const exit = once(child, 'exit')
  let stdout = '',
    stderr = '',
    status = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  child.stdio[5].on('data', (chunk) => {
    status += chunk
  })
  const setup = records(child.stdio[3]),
    message = records(child.stdio[4])
  const [s, w] = await bound(Promise.all([setup(), message()]), 'birth')
  assert.equal(s, `SETUP_COMPLETE ${nonce} ${child.pid}`)
  const match = /^ARMED ([a-f0-9]+) (\d+)$/.exec(w)
  assert(match)
  assert.equal(match[1], nonce)
  const watcher = Number(match[2])
  watchers.push(watcher)
  let fields
  if (process.platform === 'linux') {
    const stat = readFileSync(`/proc/${watcher}/stat`, 'utf8')
    const values = stat.slice(stat.lastIndexOf(') ') + 2).split(' ')
    fields = [String(watcher), ...values.slice(1, 4)]
    assert.equal(Number(fields[3]), child.pid)
  } else {
    const row = spawnSync('ps', ['-p', String(watcher), '-o', 'pid=,ppid=,pgid='], {
      encoding: 'utf8'
    })
    assert.equal(row.status, 0)
    fields = row.stdout.trim().split(/\s+/)
  }
  assert.equal(Number(fields[2]), watcher)
  assert.notEqual(Number(fields[1]), child.pid, 'watcher must not be provider waitable child')
  return {
    child,
    watcher,
    nonce,
    exit,
    message,
    stdout: () => stdout,
    stderr: () => stderr,
    status: () => status,
    exec: () => child.stdio[3].end(`EXEC ${nonce}\n`),
    command: async (command) => {
      child.stdio[4].write(
        `${command.split(' ')[0]} ${nonce} ${command.split(' ').slice(1).join(' ')}\n`
      )
      return bound(message(), 'operation')
    },
    retire: async () => {
      child.stdio[4].write(`RETIRE ${nonce}\n`)
      assert.equal(await bound(message(), 'retire'), `RETIRED ${nonce}`)
      child.stdio[4].end()
    }
  }
}
try {
  const pin = spawnSync(binary, ['pin', join(dir, 'hold')], {
    stdio: ['ignore', 'pipe', 'pipe', 'ignore', 'ignore', 'ignore', held]
  })
  assert.equal(pin.status, 0)
  const io = await start(['/bin/sh', '-c', 'cat; printf final'])
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(io.stdout(), '')
  io.exec()
  io.child.stdin.end('request\n')
  assert.deepEqual(await bound(io.exit, 'direct io'), [0, null])
  if (!io.child.stdout.readableEnded) {
    await bound(once(io.child.stdout, 'end'), 'output end')
  }
  assert.equal(io.stdout(), 'request\nfinal')
  assert.equal(io.status(), '')
  assert.match(await io.command('PROBE'), /^RESULT \w+ 0 /)
  closeSync(held)
  held = openSync(join(dir, 'hold'), 'r+')
  const lockProbe = () =>
    spawnSync(binary, ['probe-lock', join(dir, 'hold')], {
      stdio: ['ignore', 'pipe', 'pipe', 'ignore', 'ignore', 'ignore', held]
    }).status
  assert.equal(lockProbe(), 2, 'watcher retains code after the owner and provider close their FDs')
  await io.retire()
  const lastClose = Date.now() + 1500
  let lockResult
  do {
    lockResult = lockProbe()
    if (lockResult !== 2) {
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  } while (Date.now() < lastClose)
  assert.equal(lockResult, 0, 'last watcher close permits exclusive code retirement')
  assert.equal(
    spawnSync(binary, ['pin', join(dir, 'hold')], {
      stdio: ['ignore', 'pipe', 'pipe', 'ignore', 'ignore', 'ignore', held]
    }).status,
    0
  )
  result.cases.push('owner-to-gate-to-watcher code lock survives owner close and ends with watcher')
  result.cases.push('direct stdin EOF and final output; singleton watcher; no pre-exec output')
  const denied = await start(['/bin/sh', '-c', 'echo forbidden'])
  denied.child.stdio[3].end()
  assert.deepEqual(await bound(denied.exit, 'deny'), [76, null])
  assert.equal(denied.stdout(), '')
  await denied.retire()
  result.cases.push('permission EOF denies provider execution')
  for (const [args, expected] of [
    [['missing-command-orca-gate-contract'], 2],
    [['/bin/sh', '-c', 'exit 127'], null]
  ]) {
    const launched = await start(args)
    launched.exec()
    launched.child.stdin.end()
    assert.deepEqual(await bound(launched.exit, 'exec outcome'), [127, null])
    await new Promise((resolve) => setTimeout(resolve, 20))
    if (expected === null) {
      assert.equal(launched.status(), '')
    } else {
      assert.equal(launched.status(), `ERROR exec ${expected}\n`)
    }
    await launched.retire()
  }
  result.cases.push('private ENOENT distinct from genuine provider127')
  // Compare actual host exec behavior rather than imposing one libc's fallback policy.
  const malformed = join(dir, 'malformed')
  const deniedPath = join(dir, 'denied')
  const interpreter = join(dir, 'missing-interpreter')
  writeFileSync(malformed, 'printf fallback')
  writeFileSync(deniedPath, 'printf denied')
  writeFileSync(interpreter, '#!/missing-orca-interpreter\n')
  chmodSync(malformed, 0o700)
  chmodSync(deniedPath, 0o600)
  chmodSync(interpreter, 0o700)
  const withoutPath = { ...process.env }
  delete withoutPath.PATH
  for (const [args, env] of [
    [[malformed], process.env],
    [[deniedPath], process.env],
    [[interpreter], process.env],
    [[`${malformed}/command`], process.env],
    [['sh', '-c', 'printf default-path'], withoutPath],
    [['sh', '-c', 'printf empty-path'], { ...process.env, PATH: '' }]
  ]) {
    const baseline = spawnSync(args[0], args.slice(1), { env, encoding: 'utf8' })
    const launched = await start(args, env)
    launched.exec()
    launched.child.stdin.end()
    await bound(launched.exit, 'exec parity')
    if (!launched.child.stdout.readableEnded) {
      await bound(once(launched.child.stdout, 'end'), 'parity output')
    }
    if (baseline.error) {
      assert.equal(launched.status(), `ERROR exec ${Math.abs(baseline.error.errno)}\n`)
    } else {
      assert.equal(launched.status(), '')
      assert.equal(launched.child.exitCode, baseline.status)
      assert.equal(launched.stdout(), baseline.stdout)
    }
    await launched.retire()
  }
  result.cases.push('host exec parity: malformed, permissions, interpreter, ENOTDIR and PATH')
  const parent = await start(['/bin/sh', '-c', 'sleep 30 & echo spawned:$!; exit 0'])
  parent.exec()
  parent.child.stdin.end()
  assert.deepEqual(await bound(parent.exit, 'root-first'), [0, null])
  assert.match(await parent.command('PROBE'), /^RESULT \w+ 1 /)
  assert.match(await parent.command('KILL'), /^RESULT \w+ [01] /)
  const deadline = Date.now() + 1600
  let last
  do {
    last = await parent.command('PROBE')
    if (/ 0 /.test(last)) {
      break
    }
    await new Promise((r) => setTimeout(r, 25))
  } while (Date.now() < deadline)
  assert.match(last, /^RESULT \w+ 0 /)
  await parent.retire()
  result.cases.push('leaderless tools cleaned by reserved session operation')
  const isolated = await start(['/bin/cat'])
  const sibling = await start(['/bin/cat'])
  isolated.exec()
  sibling.exec()
  const lost = once(isolated.child.stdio[4], 'end')
  process.kill(isolated.watcher, 'SIGKILL')
  await bound(lost, 'watcher loss')
  isolated.child.kill('SIGKILL')
  await bound(isolated.exit, 'isolated root')
  sibling.child.stdin.end('sibling alive\n')
  await bound(sibling.exit, 'sibling')
  assert.equal(sibling.stdout(), 'sibling alive\n')
  await sibling.retire()
  result.cases.push('watcher-only death observable; sibling data unaffected')
  const crash = await start([
    '/bin/sh',
    '-c',
    'trap "" TERM; while :; do read line || break; done; sleep 30'
  ])
  crash.exec()
  const probed = await crash.command('PROBE')
  const stamp = Number(probed.split(' ').at(-1))
  assert.equal(
    await crash.command(`PHASE 1 ${stamp + 150}`),
    `PHASE ${crash.nonce} 1 ${stamp + 150}`
  )
  const startMs = Date.now()
  crash.child.stdio[4].end()
  await bound(crash.exit, 'EOF phase continuation', 2500)
  assert(Date.now() - startMs < 2000)
  result.cases.push('lifetime EOF continues accepted partial TERM deadline')
  console.log(JSON.stringify({ ...result, result: 'PASS' }))
} finally {
  closeSync(held)
  for (const child of owned) {
    child.stdio[3]?.destroy()
    child.stdio[4]?.destroy()
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
  }
  rmSync(dir, { recursive: true })
}
