import { expect, it, vi } from 'vitest'
import { StructuredAgentSessionResidency } from './structured-agent-session-residency'

it('preserves results and original errors, terminates cold refusal, and retries on a real edge', async () => {
  const resident = new Set(['a'])
  let retire = false
  const report = vi.fn()
  const residency = new StructuredAgentSessionResidency({
    limit: 1,
    held: (id) => resident.has(id),
    eligible: (id) => resident.has(id),
    close: async (id) => retire && resident.delete(id),
    report
  })
  residency.released('a')
  await expect(
    residency.run('b', async () => {
      resident.add('b')
      residency.opened('b')
      return 'sent'
    })
  ).resolves.toBe('sent')
  await residency.trim()
  const cold = vi.fn(async () => 'opened')
  await expect(residency.run('c', cold)).rejects.toThrow('could not be released')
  expect(cold).not.toHaveBeenCalled()
  const original = new Error('provider refused')
  await expect(
    residency.run('a', async () => {
      throw original
    })
  ).rejects.toBe(original)
  expect(report).toHaveBeenCalled()
  const release = residency.borrow('a')
  release()
  release()
  expect(residency.borrowed('a')).toBe(false)
  retire = true
  await residency.run('c', cold)
  expect(cold).toHaveBeenCalledOnce()
})

it('bounds N and 10N cold constructions while allowing explicitly borrowed work', async () => {
  for (const count of [30, 300]) {
    const resident = new Set<string>()
    let peak = 0
    const residency = new StructuredAgentSessionResidency({
      limit: 24,
      held: (id) => resident.has(id),
      eligible: (id) => resident.has(id),
      close: async (id) => resident.delete(id),
      report: vi.fn()
    })
    const held = residency.borrow('held')
    resident.add('held')
    await Promise.all(
      Array.from({ length: count }, (_, index) =>
        residency.run(`${index}`, async () => {
          resident.add(`${index}`)
          peak = Math.max(peak, resident.size)
          residency.opened(`${index}`)
        })
      )
    )
    await residency.trim()
    expect(peak).toBeLessThanOrEqual(26)
    expect(resident.size).toBe(25)
    expect(resident.has('held')).toBe(true)
    held()
    await residency.trim()
    expect(resident.size).toBe(24)
  }
})
