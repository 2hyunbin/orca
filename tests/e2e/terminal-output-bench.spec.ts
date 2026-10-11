/**
 * Terminal OUTPUT benchmark (bench branch only): time from a command's start until its last byte is
 * drawn in the window's xterm, for recorded real workloads (agent TUIs, test/build logs, git log -p)
 * and synthetic stress bounds, plus keystroke-echo latency while other panes stream. Also records
 * the size of every socket read on Electron main and how many bytes each event-loop turn took.
 * Writes one JSON line per scenario run to ORCA_OUTPUT_BENCH_REPORT. Never fails on a number.
 */
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import { bootstrapFirstLaunch, seededRepoPathOrSkip } from './helpers/terminal-restart-persistence'
import { waitForActiveTerminalManager } from './helpers/terminal'
import { waitForBoundPanes } from './helpers/terminal-layout-journeys'
import { presentTerminalPerfWindow } from './terminal-perf-presentation'
import { RuntimeClient } from '../../src/cli/runtime/client'
import type {
  RuntimeTerminalCreate,
  RuntimeTerminalListResult,
  RuntimeTerminalRead,
  RuntimeWorktreeCreateResult
} from '../../src/shared/runtime-types'

const LABEL = process.env.ORCA_OUTPUT_BENCH_LABEL ?? 'unlabeled'
const REPORT = process.env.ORCA_OUTPUT_BENCH_REPORT
const GROUP = process.env.ORCA_OUTPUT_BENCH_GROUP ?? 'all'
const ONLY = process.env.ORCA_OUTPUT_BENCH_ONLY?.split(',').filter(Boolean) ?? []
const FIXTURES = path.join(__dirname, 'terminal-output-bench-fixtures')
const REPLAY = path.join(__dirname, 'terminal-output-bench-replay.mjs')
const WIN = process.platform === 'win32'
const MB = 1024 * 1024
const ECHO_SAMPLES = Number(process.env.ORCA_OUTPUT_BENCH_ECHO_SAMPLES ?? 60)

type Json = Record<string, unknown>
type Done = { parsedAt: number; drawnAt: number } | { error: string }

/* eslint-disable @typescript-eslint/no-explicit-any -- bench probes reach into window globals */
async function installRendererProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as any
    if (w.__obench) {
      return
    }
    const terminals = (): Map<string, any> => {
      const out = new Map<string, any>()
      for (const manager of w.__paneManagers?.values() ?? []) {
        for (const pane of manager.getPanes?.() ?? []) {
          const id = pane.container?.dataset?.ptyId
          if (id) {
            out.set(id, pane.terminal)
          }
        }
      }
      return out
    }
    const term = (ptyId: string): any => {
      const t = terminals().get(ptyId)
      if (!t) {
        throw new Error(`no mounted pane for ${ptyId}`)
      }
      return t
    }
    const tail = (t: any, n: number): string[] => {
      const b = t.buffer.active
      const end = b.baseY + b.cursorY
      const rows: string[] = []
      for (let y = Math.max(0, end - n); y <= end; y += 1) {
        rows.push(b.getLine(y)?.translateToString(true) ?? '')
      }
      return rows
    }
    const cursorLine = (t: any): string => tail(t, 0)[0]!.trimEnd()
    const raf = (): Promise<number> =>
      new Promise((resolve) => requestAnimationFrame(() => resolve(Date.now())))
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
    const until = (
      t: any,
      pred: () => boolean,
      timeoutMs: number
    ): Promise<{ parsedAt: number; drawnAt: number }> =>
      new Promise((resolve, reject) => {
        let done = false
        const finish = (): void => {
          done = true
          sub.dispose()
          clearTimeout(timer)
        }
        const check = (): void => {
          if (!done && pred()) {
            finish()
            const parsedAt = Date.now()
            void raf().then((drawnAt) => resolve({ parsedAt, drawnAt }))
          }
        }
        const sub = t.onWriteParsed(check)
        const timer = setTimeout(() => {
          if (!done) {
            finish()
            reject(new Error('timeout'))
          }
        }, timeoutMs)
        check()
      })
    const pending = new Map<string, Promise<unknown>>()
    w.__obench = {
      ptyIdsOfActiveTab(): string[] {
        const state = w.__store.getState()
        const manager = w.__paneManagers?.get(state.activeTabId)
        return (manager?.getPanes?.() ?? []).map((p: any) => p.container.dataset.ptyId)
      },
      hasPty(ptyId: string): boolean {
        return terminals().has(ptyId)
      },
      armSentinels(key: string, ptyIds: string[], sentinel: string, timeoutMs: number): void {
        pending.set(
          key,
          Promise.allSettled(
            ptyIds.map((id) => {
              const t = term(id)
              return until(t, () => tail(t, 8).some((l) => l.startsWith(sentinel)), timeoutMs)
            })
          )
        )
      },
      tuiResult(key: string): Promise<unknown> {
        const p = pending.get(key)
        pending.delete(key)
        return p as Promise<unknown>
      },
      async result(key: string): Promise<unknown[]> {
        const settled = (await pending.get(key)) as PromiseSettledResult<unknown>[]
        pending.delete(key)
        return settled.map((s) =>
          s.status === 'fulfilled' ? s.value : { error: String(s.reason) }
        )
      },
      write(ptyIds: string[], texts: string[]): number {
        const at = Date.now()
        ptyIds.forEach((id, i) => w.api.pty.write(id, texts[i], 'driving'))
        return at
      },
      async rafRate(): Promise<number> {
        const start = performance.now()
        let frames = 0
        while (performance.now() - start < 1000) {
          await raf()
          frames += 1
        }
        return frames
      },
      // Typing in a comment line (`# abc…`) so Enter is a no-op in POSIX shells and PowerShell.
      async echoSamples(ptyId: string, count: number, gapMs: number, kind: 'key' | 'cmd') {
        const t = term(ptyId)
        const samples: { parsedMs: number; drawnMs: number }[] = []
        let typed = ''
        const timeouts = { n: 0 }
        for (let i = 0; i < count; i += 1) {
          try {
            if (kind === 'key') {
              if (i % 20 === 0) {
                if (typed) {
                  const prev = typed
                  w.api.pty.write(ptyId, '\r', 'driving')
                  await until(t, () => !cursorLine(t).endsWith(prev), 15_000)
                }
                typed = '#'
                w.api.pty.write(ptyId, '#', 'driving')
                await until(t, () => cursorLine(t).endsWith('#'), 15_000)
              }
              typed += 'abcdefghijklmnopqrstuvwxyz'[i % 26]
              const expected = typed
              const t0 = Date.now()
              w.api.pty.write(ptyId, expected.at(-1), 'driving')
              const r = await until(t, () => cursorLine(t).endsWith(expected), 15_000)
              samples.push({
                parsedMs: r.parsedAt - t0,
                drawnMs: r.drawnAt - t0
              })
            } else {
              const marker = `R${i}x${Date.now() % 100000}`
              const t0 = Date.now()
              w.api.pty.write(ptyId, `echo ${marker}\r`, 'driving')
              const r = await until(t, () => tail(t, 8).some((l) => l.trim() === marker), 15_000)
              samples.push({
                parsedMs: r.parsedAt - t0,
                drawnMs: r.drawnAt - t0
              })
            }
          } catch {
            timeouts.n += 1
            typed = ''
          }
          await sleep(gapMs)
        }
        if (kind === 'key' && typed) {
          w.api.pty.write(ptyId, '\r', 'driving')
        }
        return { samples, timeouts: timeouts.n }
      },
      armTui(key: string, ptyId: string, sentinel: string, timeoutMs: number): void {
        const t = term(ptyId)
        const drawn: { n: number; lagMs: number }[] = []
        let latest: { n: number; emitted: number } | null = null
        let lastDrawn = -1
        let rafPending = false
        const sub = t.onWriteParsed(() => {
          const b = t.buffer.active
          if (b.type !== 'alternate') {
            return
          }
          const m = /^F (\d+) (\d+)/.exec(b.getLine(b.viewportY)?.translateToString(true) ?? '')
          if (m) {
            latest = { n: Number(m[1]), emitted: Number(m[2]) }
            if (!rafPending) {
              rafPending = true
              requestAnimationFrame(() => {
                rafPending = false
                if (latest && latest.n !== lastDrawn) {
                  lastDrawn = latest.n
                  drawn.push({
                    n: latest.n,
                    lagMs: Date.now() - latest.emitted
                  })
                }
              })
            }
          }
        })
        pending.set(
          key,
          until(t, () => tail(t, 8).some((l) => l.startsWith(sentinel)), timeoutMs).then((done) => {
            sub.dispose()
            return { done, drawn }
          })
        )
      },
      async findSentinelAnywhere(sentinel: string): Promise<number | null> {
        for (const t of terminals().values()) {
          if (tail(t, 12).some((l: string) => l.startsWith(sentinel))) {
            return raf()
          }
        }
        return null
      }
    }
  })
}

async function installMainProbe(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    const g = globalThis as any
    if (g.__obenchMain) {
      return
    }
    const net = process.getBuiltinModule('node:net')
    const st = (g.__obenchMain = { sockets: new Map<string, any>() })
    const original = net.Socket.prototype.emit
    net.Socket.prototype.emit = function (this: any, event: string | symbol, ...args: any[]) {
      const chunk = args[0]
      if (event === 'data' && chunk && typeof chunk.length === 'number') {
        // One entry per socket object: unix sockets have no address to tell them apart.
        this.__obenchId ??= (g.__obenchNextId = (g.__obenchNextId ?? 0) + 1)
        const key = `socket-${this.__obenchId}-fd${this._handle?.fd ?? '?'}`
        let s = st.sockets.get(key)
        if (!s) {
          s = {
            key,
            reads: 0,
            bytes: 0,
            maxRead: 0,
            readsLe1k: 0,
            readsLe8k: 0,
            readsLe32k: 0,
            readsLt64k: 0,
            readsEq64k: 0,
            readsGt64k: 0,
            turns: 0,
            turnsAtLeast64k: 0,
            bytesInTurnsAtLeast64k: 0,
            maxTurnBytes: 0,
            turnBytes: 0,
            open: false
          }
          st.sockets.set(key, s)
        }
        const n: number = chunk.length
        s.reads += 1
        s.bytes += n
        s.maxRead = Math.max(s.maxRead, n)
        if (n <= 1024) {
          s.readsLe1k += 1
        } else if (n <= 8192) {
          s.readsLe8k += 1
        } else if (n <= 32768) {
          s.readsLe32k += 1
        } else if (n < 65536) {
          s.readsLt64k += 1
        } else if (n === 65536) {
          s.readsEq64k += 1
        } else {
          s.readsGt64k += 1
        }
        s.turnBytes += n
        if (!s.open) {
          s.open = true
          setImmediate(() => {
            s.turns += 1
            if (s.turnBytes >= 65536) {
              s.turnsAtLeast64k += 1
              s.bytesInTurnsAtLeast64k += s.turnBytes
            }
            s.maxTurnBytes = Math.max(s.maxTurnBytes, s.turnBytes)
            s.turnBytes = 0
            s.open = false
          })
        }
      }
      return original.call(this, event, ...args)
    }
  })
}

async function resetMainProbe(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => (globalThis as any).__obenchMain.sockets.clear())
}

async function readMainProbe(app: ElectronApplication): Promise<Json[]> {
  return app.evaluate(() =>
    [...(globalThis as any).__obenchMain.sockets.values()]
      .sort((a: any, b: any) => b.bytes - a.bytes)
      .slice(0, 3)
      .map(({ turnBytes: _t, open: _o, ...rest }: any) => ({
        ...rest,
        key: String(rest.key)
      }))
  )
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const q = (s: string): string =>
  WIN ? `'${s.replaceAll("'", "''")}'` : `'${s.replaceAll("'", "'\\''")}'`
const nodeCall = (args: string[]): string =>
  `${WIN ? '& ' : ''}${q(process.execPath)} ${[REPLAY, ...args].map(q).join(' ')}`

let seq = 0
function nonce(): string {
  seq += 1
  return `${Date.now().toString(36)}${seq}`
}

type Ctx = {
  app: ElectronApplication
  page: Page
  client: RuntimeClient
  worktreeId: string
  tmp: string
}

async function newTab(ctx: Ctx, panes: number): Promise<string[]> {
  const created = await ctx.client.call<{ terminal: RuntimeTerminalCreate }>('terminal.create', {
    worktree: `id:${ctx.worktreeId}`
  })
  await ctx.client.call('terminal.focus', {
    terminal: created.result.terminal.handle,
    navigation: 'host'
  })
  await waitForActiveTerminalManager(ctx.page)
  await waitForBoundPanes(ctx.page, 1)
  // Always split the largest pane along its longer side, so no pane is a sliver.
  for (let count = 1; count < panes;) {
    count = await ctx.page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- window test hooks
      const w = window as any
      const manager = w.__paneManagers.get(w.__store.getState().activeTabId)
      const sized = manager.getPanes().map((pane: any) => {
        const rect = pane.container.getBoundingClientRect()
        return { pane, rect, area: rect.width * rect.height }
      })
      const largest = sized.reduce((x: any, y: any) => (y.area > x.area ? y : x))
      manager.splitPane(
        largest.pane.id,
        largest.rect.width >= largest.rect.height * 2 ? 'vertical' : 'horizontal'
      )
      return manager.getPanes().length as number
    })
    await waitForBoundPanes(ctx.page, count)
  }
  await waitForBoundPanes(ctx.page, panes)
  const ptyIds: string[] = await ctx.page.evaluate(() =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- probe installed above
    (window as any).__obench.ptyIdsOfActiveTab()
  )
  // Every shell must be at a prompt before timing starts.
  const n = nonce()
  await runAndWait(
    ctx,
    ptyIds,
    ptyIds.map(() => (WIN ? `echo DONE-${n}` : `printf 'DONE-%s\\n' ${n}`)),
    `DONE-${n}`,
    60_000
  )
  return ptyIds
}

async function closeTab(ctx: Ctx, ptyIds: string[]): Promise<void> {
  try {
    const list = await ctx.client.call<RuntimeTerminalListResult>('terminal.list', {
      worktree: `id:${ctx.worktreeId}`
    })
    for (const terminal of list.result.terminals) {
      if (terminal.ptyId && ptyIds.includes(terminal.ptyId)) {
        await ctx.client.call('terminal.close', { terminal: terminal.handle }).catch(() => {})
      }
    }
  } catch (error) {
    console.warn('[output-bench] close tab', error)
  }
}

/** Sends one command line per pane at the same instant; resolves when every sentinel is drawn. */
async function runAndWait(
  ctx: Ctx,
  ptyIds: string[],
  commands: string[],
  sentinel: string,
  timeoutMs: number
): Promise<{ startedAt: number; done: Done[] }> {
  const key = nonce()
  await ctx.page.evaluate(
    ({ key, ptyIds, sentinel, timeoutMs }) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- probe installed above
      (window as any).__obench.armSentinels(key, ptyIds, sentinel, timeoutMs),
    { key, ptyIds, sentinel, timeoutMs }
  )
  const startedAt: number = await ctx.page.evaluate(
    ({ ptyIds, texts }) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- probe installed above
      (window as any).__obench.write(ptyIds, texts),
    { ptyIds, texts: commands.map((c) => `${c}\r`) }
  )
  const done: Done[] = await ctx.page.evaluate(
    (key) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- probe installed above
      (window as any).__obench.result(key),
    key
  )
  return { startedAt, done }
}

function replayCommand(ctx: Ctx, n: string, args: string[]): { cmd: string; stamp: string } {
  const stamp = path.join(ctx.tmp, `stamp-${n}`)
  return { cmd: nodeCall([n, stamp, ...args]), stamp }
}

function readStamp(stamp: string): number | null {
  return existsSync(stamp) ? Number(readFileSync(stamp, 'utf8')) : null
}

type Workload = {
  name: string
  group: 'realistic' | 'stress'
  run: (ctx: Ctx) => Promise<Json>
}

/** One pane per entry runs `args` at once; reports time to last drawn byte and emit→drawn lag. */
function paneWorkload(
  name: string,
  group: Workload['group'],
  perPane: (ctx: Ctx, index: number) => string[] | { posix: string; n?: never },
  panes: number,
  timeoutMs: number
): Workload {
  return {
    name,
    group,
    run: async (ctx) => {
      const ptyIds = await newTab(ctx, panes)
      const n = nonce()
      const stamps: string[] = []
      const commands = ptyIds.map((_, i) => {
        const spec = perPane(ctx, i)
        const big = (s: string, quote: boolean): string =>
          s.replace(/\{BIG(\d+)\}/g, (_m, mb: string) => {
            const file = path.join(ctx.tmp, `big${mb}.txt`)
            return quote ? q(file) : file
          })
        if (Array.isArray(spec)) {
          const { cmd, stamp } = replayCommand(
            ctx,
            `${n}`,
            spec.map((a) => big(a, false))
          )
          stamps.push(stamp)
          return cmd
        }
        return big(spec.posix, true).replaceAll('{N}', n)
      })
      await resetMainProbe(ctx.app)
      const { startedAt, done } = await runAndWait(ctx, ptyIds, commands, `DONE-${n}`, timeoutMs)
      const socket = await readMainProbe(ctx.app)
      await closeTab(ctx, ptyIds)
      return summarizeDone(startedAt, done, stamps, socket)
    }
  }
}

function summarizeDone(startedAt: number, done: Done[], stamps: string[], socket: Json[]): Json {
  const ok = done.filter((d): d is { parsedAt: number; drawnAt: number } => !('error' in d))
  const emitted = stamps.map(readStamp).filter((s): s is number => s !== null)
  return {
    errors: done.length - ok.length,
    allDrawnMs: ok.length ? Math.max(...ok.map((d) => d.drawnAt)) - startedAt : null,
    allParsedMs: ok.length ? Math.max(...ok.map((d) => d.parsedAt)) - startedAt : null,
    perPaneDrawnMs: ok.map((d) => d.drawnAt - startedAt),
    // Lag after the producer finished writing: how far the window trailed the program.
    trailingLagMs:
      emitted.length === ok.length && ok.length
        ? Math.max(...ok.map((d, i) => d.drawnAt - emitted[i]!))
        : null,
    socket
  }
}

async function echoSamples(
  ctx: Ctx,
  ptyId: string,
  kind: 'key' | 'cmd',
  count: number,
  gapMs: number
): Promise<Json> {
  return ctx.page.evaluate(
    ({ ptyId, kind, count, gapMs }) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- probe installed above
      (window as any).__obench.echoSamples(ptyId, count, gapMs, kind),
    { ptyId, kind, count, gapMs }
  )
}

/** Typing latency in pane 0 while the other panes run `background` until done (or until sampled). */
function typingUnder(
  name: string,
  group: Workload['group'],
  backgroundPanes: number,
  background: (ctx: Ctx, n: string, index: number) => string,
  stopWithCtrlC: boolean
): Workload {
  return {
    name,
    group,
    run: async (ctx) => {
      const ptyIds = await newTab(ctx, backgroundPanes + 1)
      const [typing, ...others] = ptyIds as [string, ...string[]]
      const idleKey = await echoSamples(ctx, typing, 'key', 20, 30)
      const n = nonce()
      await resetMainProbe(ctx.app)
      const key = nonce()
      if (!stopWithCtrlC) {
        await ctx.page.evaluate(
          ({ key, others, sentinel }) =>
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- probe installed above
            (window as any).__obench.armSentinels(key, others, sentinel, 600_000),
          { key, others, sentinel: `DONE-${n}` }
        )
      }
      const startedAt: number = await ctx.page.evaluate(
        ({ others, texts }) =>
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- probe installed above
          (window as any).__obench.write(others, texts),
        { others, texts: others.map((_, i) => `${background(ctx, n, i)}\r`) }
      )
      await new Promise((r) => setTimeout(r, 1500))
      const key1 = await echoSamples(ctx, typing, 'key', ECHO_SAMPLES, 150)
      const cmd = await echoSamples(ctx, typing, 'cmd', Math.max(50, ECHO_SAMPLES), 150)
      let backgroundDone: Json = {}
      if (stopWithCtrlC) {
        await ctx.page.evaluate(
          ({ others }) =>
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- probe installed above
            (window as any).__obench.write(
              others,
              others.map(() => '\x03')
            ),
          { others }
        )
        await new Promise((r) => setTimeout(r, 1000))
      } else {
        const done: Done[] = await ctx.page.evaluate(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- probe installed above
          (key) => (window as any).__obench.result(key),
          key
        )
        backgroundDone = summarizeDone(startedAt, done, [], [])
      }
      const socket = await readMainProbe(ctx.app)
      await closeTab(ctx, ptyIds)
      return { idleKey, key: key1, cmd, backgroundDone, socket }
    }
  }
}

const fixture = (name: string): string => path.join(FIXTURES, name)
const posixOr =
  (posix: string, win: string[]): ((ctx: Ctx) => string[] | { posix: string }) =>
  () =>
    WIN ? win : { posix: `${posix}; printf 'DONE-%s\\n' {N}` }

const WORKLOADS: Workload[] = [
  // Realistic: recorded real sessions, replayed at their recorded pace.
  paneWorkload(
    'agent-claude-code-1x',
    'realistic',
    () => ['timed', fixture('claude-code.json.gz')],
    1,
    300_000
  ),
  paneWorkload(
    'agent-codex-1x',
    'realistic',
    () => ['timed', fixture('codex.json.gz')],
    1,
    300_000
  ),
  paneWorkload(
    'agents-4-panes-1x',
    'realistic',
    (_ctx, i) => ['timed', fixture(i % 2 === 0 ? 'codex.json.gz' : 'claude-code.json.gz')],
    4,
    300_000
  ),
  paneWorkload(
    'vitest-log-1x',
    'realistic',
    () => ['timed', fixture('vitest-run.json.gz')],
    1,
    300_000
  ),
  paneWorkload(
    'pnpm-install-1x',
    'realistic',
    () => ['timed', fixture('pnpm-install.json.gz')],
    1,
    120_000
  ),
  // Realistic bursts: whole output available at once (cat a log, git log -p, a big file).
  paneWorkload(
    'git-log-p-2.8MB-burst',
    'realistic',
    () => ['burst', fixture('git-log-p.txt.gz')],
    1,
    300_000
  ),
  paneWorkload(
    'vitest-log-2.8MB-burst',
    'realistic',
    () => ['burst', fixture('vitest-run.json.gz')],
    1,
    300_000
  ),
  paneWorkload(
    'codex-transcript-0.7MB-burst',
    'realistic',
    () => ['burst', fixture('codex.json.gz')],
    1,
    300_000
  ),
  paneWorkload(
    'cat-pnpm-lock-0.56MB',
    'realistic',
    posixOr(`cat ${q(path.resolve(__dirname, '../../pnpm-lock.yaml'))}`, [
      'burst',
      path.resolve(__dirname, '../../pnpm-lock.yaml')
    ]),
    1,
    120_000
  ),
  typingUnder(
    'typing-while-4-agents',
    'realistic',
    4,
    (ctx, n, i) =>
      replayCommand(ctx, n, [
        'timed',
        fixture(i % 2 === 0 ? 'codex.json.gz' : 'claude-code.json.gz')
      ]).cmd,
    false
  ),
  typingUnder(
    'typing-while-vitest-log',
    'realistic',
    1,
    (ctx, n) => replayCommand(ctx, n, ['timed', fixture('vitest-run.json.gz')]).cmd,
    false
  ),
  // Stress bounds.
  paneWorkload(
    'stress-cat-50MB',
    'stress',
    posixOr(`cat {BIG50}`, ['burst', '{BIG50}']),
    1,
    900_000
  ),
  paneWorkload(
    'stress-yes-head-50MB',
    'stress',
    posixOr(`yes | head -c ${50 * MB}`, ['yes', String(50 * MB)]),
    1,
    900_000
  ),
  paneWorkload(
    'stress-seq-10M',
    'stress',
    posixOr('seq 1 10000000', ['seq', '10000000']),
    1,
    900_000
  ),
  paneWorkload(
    'stress-3-panes-20MB',
    'stress',
    posixOr(`cat {BIG20}`, ['burst', '{BIG20}']),
    3,
    900_000
  ),
  paneWorkload(
    'stress-6-panes-20MB',
    'stress',
    posixOr(`cat {BIG20}`, ['burst', '{BIG20}']),
    6,
    900_000
  ),
  typingUnder(
    'stress-typing-while-flood',
    'stress',
    1,
    (ctx, n) => replayCommand(ctx, n, ['flood']).cmd,
    true
  ),
  {
    name: 'stress-tui-60fps-10s',
    group: 'stress',
    run: async (ctx) => {
      const [ptyId] = (await newTab(ctx, 1)) as [string]
      const n = nonce()
      const { cmd } = replayCommand(ctx, n, ['tui', '10', '60'])
      const key = nonce()
      await resetMainProbe(ctx.app)
      await ctx.page.evaluate(
        ({ key, ptyId, sentinel }) =>
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- probe installed above
          (window as any).__obench.armTui(key, ptyId, sentinel, 120_000),
        { key, ptyId, sentinel: `DONE-${n}` }
      )
      const startedAt: number = await ctx.page.evaluate(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- probe installed above
        ({ ptyId, cmd }) => (window as any).__obench.write([ptyId], [`${cmd}\r`]),
        { ptyId, cmd }
      )
      const { done, drawn } = (await ctx.page.evaluate(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- probe installed above
        (key) => (window as any).__obench.tuiResult(key),
        key
      )) as unknown as {
        done: { drawnAt: number }
        drawn: { n: number; lagMs: number }[]
      }
      const socket = await readMainProbe(ctx.app)
      await closeTab(ctx, [ptyId])
      const lags = drawn.map((d) => d.lagMs).toSorted((a, b) => a - b)
      return {
        totalDrawnMs: done.drawnAt - startedAt,
        framesEmitted: 600,
        framesDrawn: drawn.length,
        frameLagP50: lags[Math.floor(lags.length / 2)] ?? null,
        frameLagP95: lags[Math.floor(lags.length * 0.95)] ?? null,
        frameLagMax: lags.at(-1) ?? null,
        framesOver50ms: lags.filter((l) => l > 50).length,
        socket
      }
    }
  },
  hiddenWorkload('hidden-worktree-cat-50MB', 'stress', (ctx, n) =>
    WIN
      ? replayCommand(ctx, n, ['burst', `${ctx.tmp}/big50.txt`]).cmd
      : `cat ${q(path.join(ctx.tmp, 'big50.txt'))}; printf 'DONE-%s\\n' ${n}`
  ),
  hiddenWorkload(
    'hidden-worktree-codex-1x',
    'realistic',
    (ctx, n) => replayCommand(ctx, n, ['timed', fixture('codex.json.gz')]).cmd
  )
]

/** Output in a worktree that is never shown: main still ingests it. Timed via terminal.read. */
function hiddenWorkload(
  name: string,
  group: Workload['group'],
  command: (ctx: Ctx, n: string) => string
): Workload {
  return {
    name,
    group,
    run: async (ctx) => {
      console.log('[output-bench] hidden: worktree.show')
      const shown = await ctx.client.call<{ worktree: { repoId: string } }>('worktree.show', {
        worktree: `id:${ctx.worktreeId}`
      })
      const created = await ctx.client.call<RuntimeWorktreeCreateResult>('worktree.create', {
        repo: `id:${shown.result.worktree.repoId}`,
        name: `obench-${nonce()}`,
        noParent: true,
        activate: false,
        setupDecision: 'skip'
      })
      const hiddenId = created.result.worktree.id
      console.log(`[output-bench] hidden worktree ${hiddenId}`)
      try {
        const term = await ctx.client.call<{ terminal: RuntimeTerminalCreate }>('terminal.create', {
          worktree: `id:${hiddenId}`
        })
        const handle = term.result.terminal.handle
        console.log(`[output-bench] hidden terminal ${handle}`)
        const readTail = async (): Promise<string> =>
          (
            await ctx.client.call<{ terminal: RuntimeTerminalRead }>('terminal.read', {
              terminal: handle,
              limit: 12
            })
          ).result.terminal.tail.join('\n')
        const ready = nonce()
        await ctx.client.call('terminal.send', {
          terminal: handle,
          text: WIN ? `echo DONE-${ready}` : `printf 'DONE-%s\\n' ${ready}`,
          enter: true
        })
        const deadline = Date.now() + 60_000
        let lastLog = 0
        while (!new RegExp(`^DONE-${ready}`, 'm').test(await readTail())) {
          if (Date.now() - lastLog > 5000) {
            lastLog = Date.now()
            console.log(`[output-bench] hidden tail: ${JSON.stringify(await readTail())}`)
          }
          if (Date.now() > deadline) {
            throw new Error('hidden shell never became ready')
          }
          await new Promise((r) => setTimeout(r, 100))
        }
        const n = nonce()
        await resetMainProbe(ctx.app)
        const startedAt = Date.now()
        await ctx.client.call('terminal.send', {
          terminal: handle,
          text: command(ctx, n),
          enter: true
        })
        const end = Date.now() + 900_000
        let lastTailLog = 0
        while (!new RegExp(`^DONE-${n}`, 'm').test(await readTail())) {
          if (Date.now() - lastTailLog > 10_000) {
            lastTailLog = Date.now()
            console.log(
              `[output-bench] hidden run tail: ${JSON.stringify((await readTail()).slice(-300))}`
            )
          }
          if (Date.now() > end) {
            throw new Error('hidden output never finished')
          }
          await new Promise((r) => setTimeout(r, 50))
        }
        const ingestedMs = Date.now() - startedAt
        const socket = await readMainProbe(ctx.app)
        const stamp = readStamp(path.join(ctx.tmp, `stamp-${n}`))
        await ctx.client.call('terminal.close', { terminal: handle }).catch(() => {})
        return {
          mainIngestedMs: ingestedMs,
          trailingLagMs: stamp ? startedAt + ingestedMs - stamp : null,
          socket
        }
      } finally {
        await ctx.client
          .call('worktree.rm', {
            worktree: `id:${hiddenId}`,
            force: true,
            runHooks: false
          })
          .catch(() => {})
      }
    }
  }
}

function writeBigFile(file: string, bytes: number): void {
  const line = (i: number): string =>
    `${String(i).padStart(8, '0')} src/main/daemon/client.ts:${i % 997} const value${i % 31} = await reader.feed(chunk) // ok\n`
  let out = ''
  let i = 0
  while (out.length < bytes) {
    out += line(i++)
  }
  writeFileSync(file, `${out.slice(0, bytes - 1)}\n`)
}

// oxlint-disable-next-line no-empty-pattern -- The benchmark owns its launch.
test('terminal output bench', async ({}, testInfo) => {
  test.setTimeout(120 * 60_000)
  const repoPath = seededRepoPathOrSkip()
  const session = createRestartSession(testInfo)
  const { app, page } = await session.launch()
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'orca-output-bench-'))
  try {
    await presentTerminalPerfWindow(app, testInfo)
    writeBigFile(path.join(tmp, 'big50.txt'), 50 * MB)
    writeBigFile(path.join(tmp, 'big20.txt'), 20 * MB)
    const { worktreeId } = await bootstrapFirstLaunch(page, repoPath)
    const client = new RuntimeClient(session.userDataDir, 60_000)
    await installRendererProbe(page)
    await installMainProbe(app)
    const ctx: Ctx = { app, page, client, worktreeId, tmp }
    const rafPerSecond: number = await page.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- probe installed above
      () => (window as any).__obench.rafRate()
    )
    const selected = WORKLOADS.filter(
      (w) => (GROUP === 'all' || w.group === GROUP) && (ONLY.length === 0 || ONLY.includes(w.name))
    )
    for (const workload of selected) {
      const startedAt = Date.now()
      let result: Json
      try {
        result = await Promise.race([
          workload.run(ctx),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('workload timed out')), 15 * 60_000)
          )
        ])
      } catch (error) {
        result = { error: String(error) }
      }
      const line = {
        label: LABEL,
        platform: process.platform,
        scenario: workload.name,
        group: workload.group,
        rafPerSecond,
        wallMs: Date.now() - startedAt,
        ...result
      }
      console.log(`[output-bench] ${JSON.stringify({ ...line, socket: undefined })}`)
      if (REPORT) {
        appendFileSync(REPORT, `${JSON.stringify(line)}\n`)
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
    await session.close(app)
    await session.dispose()
  }
})
