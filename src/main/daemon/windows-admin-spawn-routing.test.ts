import { describe, expect, it, vi } from 'vitest'
import { createAdapter } from './daemon-pty-router-test-fixture'
import { DaemonPtyRouter } from './daemon-pty-router'
import { DegradedDaemonPtyProvider } from './degraded-daemon-pty-provider'

function setup() {
  const current = createAdapter('ordinary', ['ordinary-existing'])
  const administrator = Object.assign(createAdapter('administrator', ['admin-existing']), {
    windowsAdministrator: true as const
  })
  const router = new DaemonPtyRouter({ current, legacy: [administrator] })
  return { current, administrator, router }
}

describe('administrator terminal routing', () => {
  it('runs opted-in new panes on a separate host and keeps ordinary panes separate', async () => {
    const { router, current, administrator } = setup()
    const onData = vi.fn()
    router.onData(onData)
    await router.spawn({ cols: 80, rows: 24, windowsRunAsAdministrator: true })
    await router.spawn({ cols: 80, rows: 24 })
    expect(administrator.spawn).toHaveBeenCalledOnce()
    expect(current.spawn).toHaveBeenCalledOnce()
    administrator.emitData('administrator-new', 'Administrator PowerShell')
    router.write('administrator-new', 'whoami\r')
    expect(onData).toHaveBeenCalledWith(
      expect.objectContaining({ data: 'Administrator PowerShell' })
    )
    expect(administrator.write).toHaveBeenCalledWith('administrator-new', 'whoami\r')
    expect(current.write).not.toHaveBeenCalled()
  })

  it('reattaches both privilege levels after app restart even when the setting changes', async () => {
    const { router, current, administrator } = setup()
    await router.discoverLegacySessions()
    await router.spawn({
      cols: 80,
      rows: 24,
      sessionId: 'admin-existing',
      windowsRunAsAdministrator: false
    })
    await router.spawn({
      cols: 80,
      rows: 24,
      sessionId: 'ordinary-existing',
      windowsRunAsAdministrator: true
    })
    expect(administrator.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'admin-existing' })
    )
    expect(current.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'ordinary-existing' })
    )
    await router.shutdown('admin-existing', { immediate: true })
    expect(administrator.shutdown).toHaveBeenCalledWith('admin-existing', { immediate: true })
    expect(current.shutdown).not.toHaveBeenCalled()
  })

  it('never downgrades to an ordinary shell when elevation is unavailable or canceled', async () => {
    const { router, current, administrator } = setup()
    vi.mocked(administrator.spawn).mockRejectedValueOnce(
      new Error('Administrator terminal canceled')
    )
    await expect(
      router.spawn({ cols: 80, rows: 24, windowsRunAsAdministrator: true })
    ).rejects.toThrow('canceled')
    expect(current.spawn).not.toHaveBeenCalled()
    const unsupported = new DaemonPtyRouter({ current, legacy: [] })
    await expect(
      unsupported.spawn({ cols: 80, rows: 24, windowsRunAsAdministrator: true })
    ).rejects.toThrow('unavailable')
    expect(current.spawn).not.toHaveBeenCalled()
  })

  it('preserves elevation during degraded routing and after ordinary host recovery', async () => {
    const { current, administrator } = setup()
    const fallback = createAdapter('fallback')
    const provider = new DegradedDaemonPtyProvider({
      current,
      legacy: [administrator],
      fallback,
      probeCurrentDaemonSpawn: async () => true
    })
    await provider.spawn({ cols: 80, rows: 24, windowsRunAsAdministrator: true })
    await provider.recoverFreshSpawnRouting()
    await provider.spawn({ cols: 80, rows: 24, windowsRunAsAdministrator: true })
    expect(administrator.spawn).toHaveBeenCalledTimes(2)
    expect(current.spawn).not.toHaveBeenCalled()
    expect(fallback.spawn).not.toHaveBeenCalled()
    const unsupported = new DegradedDaemonPtyProvider({ current, legacy: [], fallback })
    await expect(
      unsupported.spawn({ cols: 80, rows: 24, windowsRunAsAdministrator: true })
    ).rejects.toThrow('unavailable')
    expect(fallback.spawn).not.toHaveBeenCalled()
  })
})
