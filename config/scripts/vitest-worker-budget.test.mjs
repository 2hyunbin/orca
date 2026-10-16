import { resolve } from 'node:path'
import { resolveConfig } from 'vitest/node'
import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => vi.unstubAllEnvs())

function resolveWorkers(options = {}) {
  return resolveConfig(
    { config: resolve('config/vitest.config.ts'), ...options },
    { logLevel: 'silent' }
  )
}

it('applies the worker budget to normal projects and preserves the isolated measurement', async () => {
  vi.stubEnv('ORCA_TEST_MAX_WORKERS', '2')
  const config = await resolveWorkers()
  expect(config.test.maxWorkers).toBe(2)
  for (const { projectConfig } of config.test.resolvedProjects) {
    expect(projectConfig.maxWorkers).toBe(projectConfig.name === 'node-measurement' ? 1 : 2)
  }
})

it('lets an explicit Vitest worker option override the environment budget', async () => {
  vi.stubEnv('ORCA_TEST_MAX_WORKERS', '2')
  const config = await resolveWorkers({ maxWorkers: 1 })
  expect(config.test.maxWorkers).toBe(1)
  expect(
    config.test.resolvedProjects.every(({ projectConfig }) => projectConfig.maxWorkers === 1)
  ).toBe(true)
})

it('rejects an invalid worker budget before starting tests', async () => {
  vi.stubEnv('ORCA_TEST_MAX_WORKERS', '0')
  await expect(resolveWorkers()).rejects.toThrow('ORCA_TEST_MAX_WORKERS must be a positive integer')
})
