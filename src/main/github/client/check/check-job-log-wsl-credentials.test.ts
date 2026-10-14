import type { SpawnOptions } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createFakeSpawnedChild,
  completeFakeSpawn,
  type FakeSpawnOutcome
} from '../../../../shared/__fixtures__/fake-spawned-child'
import { attachLogFixture, failedLogJob } from './check-job-log-test-fixture'
import { prCheckLogTailCache } from './check-job-log-tails'
import { setDefaultWslDistroOverride } from '../../../git/runner'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('node:child_process', async (original) => ({ ...(await original()), spawn: spawnMock }))
const platform = process.platform
const options = { cwd: 'C:\\folder', wslDistro: 'Ubuntu', env: { GH_TOKEN: 'windows-only' } }
let guestToken = 'guest-A'
let nativeToken = 'native-A'
let guestMissing = false
let nativeMissing = false
let missingAfterAuth = false
let switchAfterAuth = false
let probeResult: FakeSpawnOutcome | undefined

function invocation(program: string, argv: string[]): string {
  return program.endsWith('wsl.exe') ? (argv.at(-1) ?? '') : argv.join(' ')
}

function isAuth(program: string, argv: string[]): boolean {
  return invocation(program, argv).replaceAll("'", '').includes('auth token')
}

function capture(program: string, argv: string[], spawnOptions: SpawnOptions): FakeSpawnOutcome {
  const guest = program.endsWith('wsl.exe')
  const auth = isAuth(program, argv)
  if (guest && guestMissing) {
    return { code: 127, stderr: 'bash: gh: command not found' }
  }
  if (!guest && nativeMissing) {
    return { spawnError: Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }) }
  }
  if (auth) {
    if (probeResult) {
      return probeResult
    }
    if (missingAfterAuth) {
      guestMissing = true
    }
    const command = invocation(program, argv)
    const bound = command.includes('--user')
    if (bound) {
      expect(spawnOptions.env?.GH_TOKEN).toBeUndefined()
      expect(spawnOptions.env?.GH_ENTERPRISE_TOKEN).toBeUndefined()
    }
    const resolvedToken = bound
      ? `bound-${guest ? 'guest' : 'native'}-${command.includes('Alice') ? 'Alice' : 'Bob'}`
      : guest
        ? guestToken
        : nativeToken
    if (switchAfterAuth) {
      guestToken = 'guest-B'
    }
    return { stdout: resolvedToken }
  }
  const env = spawnOptions.env ?? {}
  const forwarded = (env.WSLENV ?? '').split(':')
  const cloud = !invocation(program, argv).includes('enterprise.test')
  const variable = cloud ? 'GH_TOKEN' : 'GH_ENTERPRISE_TOKEN'
  const token = guest
    ? forwarded.includes(variable)
      ? env[variable]
      : guestToken
    : (env[variable] ?? nativeToken)
  expect(token).toBeTruthy()
  return { stdout: `Error: ${token}` }
}

const apiCalls = () => spawnMock.mock.calls.filter(([program, argv]) => !isAuth(program, argv))
const authCalls = () => spawnMock.mock.calls.filter(([program, argv]) => isAuth(program, argv))

function spawnFixture(program: string, argv: string[], spawnOptions: SpawnOptions) {
  const child = createFakeSpawnedChild()
  const outcome = capture(program, argv, spawnOptions)
  if ('spawnError' in outcome) {
    Object.defineProperty(child, 'pid', { value: undefined })
    queueMicrotask(() => child.emit('error', outcome.spawnError))
  } else {
    queueMicrotask(() => completeFakeSpawn(child, outcome))
  }
  return child
}

describe('effective credentials and runtime for WSL log reuse', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    setDefaultWslDistroOverride('Ubuntu')
    guestToken = 'guest-A'
    nativeToken = 'native-A'
    guestMissing = nativeMissing = missingAfterAuth = switchAfterAuth = false
    probeResult = undefined
    prCheckLogTailCache.clear()
    spawnMock.mockReset().mockImplementation(spawnFixture)
  })
  afterEach(async () => {
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(0)
    setDefaultWslDistroOverride(null)
    Object.defineProperty(process, 'platform', { configurable: true, value: platform })
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it.each([1, 5])(
    'downloads %s jobs once across ten visits and shares cold concurrent readers',
    async (count) => {
      const jobs = () => Array.from({ length: count }, (_, index) => failedLogJob(index + 1))
      for (let visit = 0; visit < 10; visit++) {
        const result = jobs()
        await attachLogFixture(result, { options })
        expect(result.every((job) => job.logTail === 'Error: guest-A')).toBe(true)
      }
      expect(apiCalls()).toHaveLength(count)
      expect(authCalls()).toHaveLength(10)
      for (const [, , spawnOptions] of apiCalls()) {
        expect(spawnOptions.env.GH_TOKEN).toBe('guest-A')
        expect(spawnOptions.env.WSLENV.split(':')).toEqual(
          expect.arrayContaining(['GH_TOKEN', 'GH_PROMPT_DISABLED'])
        )
      }
      prCheckLogTailCache.clear()
      await Promise.all([
        attachLogFixture(jobs(), { options }),
        attachLogFixture(jobs(), { options })
      ])
      expect(apiCalls()).toHaveLength(count * 2)
      expect(prCheckLogTailCache.size).toBe(count)
    }
  )

  it('partitions guest credentials, distros and UNC workspaces without exposing tokens in cache keys', async () => {
    const first = [failedLogJob()]
    await attachLogFixture(first, { options })
    guestToken = 'guest-B'
    const second = [failedLogJob()]
    await attachLogFixture(second, { options })
    guestToken = 'guest-A'
    await attachLogFixture([failedLogJob()], { options })
    expect(apiCalls()).toHaveLength(2)
    await attachLogFixture([failedLogJob()], { options: { ...options, wslDistro: 'Debian' } })
    const unc = { cwd: String.raw`\\wsl.localhost\Ubuntu\home\folder`, env: {} }
    await attachLogFixture([failedLogJob()], { options: unc })
    await attachLogFixture([failedLogJob()], { options: unc })
    expect(apiCalls()).toHaveLength(4)
    expect(first[0].logTail).toBe('Error: guest-A')
    expect(second[0].logTail).toBe('Error: guest-B')
    expect(JSON.stringify([...prCheckLogTailCache.keys()])).not.toContain('guest-')
  })

  it('separates the actual fallback runtime even when native and guest tokens are identical', async () => {
    nativeToken = guestToken
    guestMissing = true
    await attachLogFixture([failedLogJob()], { options })
    const firstDownloads = apiCalls().length
    guestMissing = false
    await attachLogFixture([failedLogJob()], { options })
    expect(apiCalls()).toHaveLength(firstDownloads + 1)
    guestMissing = true
    await attachLogFixture([failedLogJob()], { options })
    expect(apiCalls()).toHaveLength(firstDownloads + 1)
    expect(prCheckLogTailCache.size).toBe(2)
  })

  it.each(['github.com', 'github.enterprise.test'])(
    'pins a bound account across host fallback for %s',
    async (host) => {
      const repo = { owner: 'acme', repo: 'widgets', host }
      const bound = {
        ...options,
        ghAccount: { host, user: 'Alice' },
        env: { GH_TOKEN: 'ambient', GH_ENTERPRISE_TOKEN: 'ambient' }
      }
      missingAfterAuth = true
      const first = [failedLogJob()]
      await attachLogFixture(first, { repo, options: bound })
      expect(first[0].logTail).toBe('Error: bound-guest-Alice')
      missingAfterAuth = false
      const second = [failedLogJob()]
      await attachLogFixture(second, { repo, options: bound })
      expect(second[0].logTail).toBe('Error: bound-native-Alice')
      const third = [failedLogJob()]
      await attachLogFixture(third, {
        repo,
        options: { ...bound, ghAccount: { host, user: 'Bob' } }
      })
      expect(third[0].logTail).toBe('Error: bound-native-Bob')
      expect(prCheckLogTailCache.size).toBe(3)
    }
  )

  it('reuses cwd-less Windows calls after native-to-default-WSL fallback', async () => {
    nativeMissing = true
    const globalOptions = { env: {} }
    const jobs = [failedLogJob()]
    await attachLogFixture(jobs, { options: globalOptions })
    const downloads = apiCalls().length
    await attachLogFixture([failedLogJob()], { options: globalOptions })
    expect(apiCalls()).toHaveLength(downloads)
    expect(jobs[0].logTail).toBe('Error: guest-A')
    expect(prCheckLogTailCache.size).toBe(1)
  })

  it('replaces credential transformation/direction flags while preserving unrelated WSLENV entries', async () => {
    switchAfterAuth = true
    const jobs = [failedLogJob()]
    await attachLogFixture(jobs, {
      options: { ...options, env: { WSLENV: 'USERPROFILE/p:GH_TOKEN/pw:GH_PROMPT_DISABLED/w' } }
    })
    expect(jobs[0].logTail).toBe('Error: guest-A')
    expect(apiCalls()[0][2].env.WSLENV.split(':')).toEqual([
      'USERPROFILE/p',
      'GH_TOKEN',
      'GH_PROMPT_DISABLED'
    ])
  })

  it.each([
    { stdout: '' },
    { stdout: 'wrapper banner\nguest-A' },
    { stdout: 'x'.repeat(20 * 1024) },
    { code: 1, stderr: 'keyring unavailable' }
  ])(
    'preserves uncached log retrieval when the credential probe is unusable %#',
    async (outcome) => {
      probeResult = outcome
      const jobs = [failedLogJob()]
      await attachLogFixture(jobs, { options })
      await attachLogFixture(jobs, { options })
      expect(jobs[0].logTail).toBe('Error: guest-A')
      expect(apiCalls()).toHaveLength(2)
      expect(prCheckLogTailCache.size).toBe(0)
    }
  )
})
