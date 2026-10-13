import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { EnvironmentRecipeJournalBinding } from '../../shared/plugins/plugin-environment-recipe-journal'
import { writeSecureFile } from '../../shared/secure-file'

export async function createPluginEnvironmentProviderControlContext(options: {
  userDataPath: string
  binding: EnvironmentRecipeJournalBinding
  launchEnvironment(): Promise<NodeJS.ProcessEnv>
  signal: AbortSignal
  isCurrent(): boolean
  previewId?: string
}) {
  const { binding } = options
  if (!binding.contextId) {
    throw new Error('Provider commands require an explicit account context')
  }
  const key = createHash('sha256').update(binding.providerId).digest('hex')
  const base = join(options.userDataPath, 'plugin-environment-provider-control', key)
  const cwd = options.previewId ? join(base, 'migration', options.previewId) : base
  if (
    !writeSecureFile(join(cwd, '.orca-provider-control'), JSON.stringify(binding), {
      durable: true
    })
  ) {
    throw new Error('Environment control directory permissions could not be restricted')
  }
  return {
    binding: structuredClone(binding),
    contextId: binding.contextId,
    cwd,
    env: { ...(await options.launchEnvironment()) },
    signal: options.signal,
    isCurrent: options.isCurrent
  }
}
