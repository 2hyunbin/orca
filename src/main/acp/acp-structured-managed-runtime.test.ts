import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import type { StructuredAgentCommandSettings } from '../native-chat/structured-agent-command-resolution'
import { createAcpStructuredLaunchResolver } from '../runtime/structured-agent-launch-composition.test-support'
import { GROK, openAcpAdapterRig } from './acp-structured-adapter.test-support'

afterEach(() => closeProviderTimelineRigs())

it('installs the managed runtime only when no copy is found, and never for a Command setting', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'orca-acp-managed-'))
  const folder = () => join(dataDirectory, 'runtimes', 'grok')
  const materialize = vi.fn(async () => {
    await mkdir(folder(), { recursive: true })
    await writeFile(join(folder(), 'grok'), '')
  })
  const spec = { ...GROK, managedRuntime: { folder, materialize } }
  const signal = new AbortController().signal
  const spawn = async (commandSettings: StructuredAgentCommandSettings) => {
    const resolve = createAcpStructuredLaunchResolver(spec, {
      store: {
        getRecord: () => ({
          ...agentSessionRecordFixture(),
          provider: 'grok',
          providerHandleChain: [],
          accountHome: { variable: 'GROK_HOME', path: join(dataDirectory, '.grok') }
        }),
        pinLaunchDirectory: vi.fn()
      },
      readJournal: () => null,
      resolveEnvironment: async () => ({ PATH: '' }),
      resolveCommandSettings: () => commandSettings,
      dataDirectory,
      // Only the composed PATH, so a copy installed on this machine cannot answer.
      resolveCommand: (command, options) =>
        (options?.pathEnv ?? '')
          .split(delimiter)
          .map((dir) => join(dir, command))
          .find((path) => existsSync(path)) ?? command
    })
    const rig = await openAcpAdapterRig({ spec, deps: { resolveLaunch: resolve, dataDirectory } })
    await rig.acquire({ signal })
    return rig.child().launch.command
  }
  const custom = join(dataDirectory, 'custom-grok.cmd')
  await writeFile(custom, '', { mode: 0o755 })
  expect(await spawn({ agentCmdOverrides: { grok: custom } })).toBe(custom)
  expect(materialize).not.toHaveBeenCalled()
  expect(await spawn({})).toBe(join(folder(), 'grok'))
  expect(materialize).toHaveBeenCalledExactlyOnceWith(dataDirectory, signal)
  await rm(dataDirectory, { recursive: true, force: true })
})
