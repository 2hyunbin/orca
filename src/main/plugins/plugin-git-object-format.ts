import type { GitCapabilityCache } from '../../shared/git-capability-cache'
import { isUnsupportedGitSha256InitError } from '../../shared/git-object-format-capability'

export async function initializePluginSha256Repository(input: {
  repository: string
  workingDirectory: string
  capabilities: GitCapabilityCache
  run: (args: string[], cwd: string) => Promise<string>
}): Promise<void> {
  await input.capabilities.runWithFallback(
    'init-sha256',
    () =>
      input.run(
        ['init', '--quiet', '--template=', '--object-format=sha256', input.repository],
        input.workingDirectory
      ),
    async () => {
      throw new Error(
        'This plugin release requires Git with SHA-256 repository support. Update Git and retry.'
      )
    },
    isUnsupportedGitSha256InitError
  )
}
