import { expect, it, vi } from 'vitest'
import { DESKTOP_PRESENCE_REPORT_INTERVAL_MS } from '../../shared/desktop-client-presence'
import { createDesktopPresenceReporter } from './desktop-presence-reporter'

it('reports on change, on a new socket and as a keepalive, and never reports unknown as present', async () => {
  let away: boolean | undefined = false
  let now = 0
  let socket = 1
  const request = vi.fn(async () => ({ ok: true }))
  const listTargets = vi.fn(() => [{ environmentId: 'ssh-host', socket, request }])
  const tick = createDesktopPresenceReporter({ readAway: () => away, listTargets, now: () => now })
  const reported = () => request.mock.calls.map((call) => (call as unknown[])[1])

  tick()
  tick()
  expect(listTargets).toHaveBeenCalledWith('notifications.desktop-presence.v1')
  expect(reported()).toEqual([{ away: false }])
  away = undefined
  tick()
  expect(reported()).toEqual([{ away: false }, { away: true }])
  now += DESKTOP_PRESENCE_REPORT_INTERVAL_MS
  tick()
  expect(reported()).toHaveLength(3)
  away = false
  socket = 2
  now += 1
  tick()
  socket = 3
  tick()
  expect(reported()).toEqual([
    { away: false },
    { away: true },
    { away: true },
    { away: false },
    { away: false }
  ])

  request.mockRejectedValueOnce(new Error('socket closed'))
  socket = 4
  tick()
  await Promise.resolve()
  await Promise.resolve()
  tick()
  expect(reported()).toHaveLength(7)
})
