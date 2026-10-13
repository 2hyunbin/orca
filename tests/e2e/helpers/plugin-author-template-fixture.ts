import { join } from 'node:path'
import { runProcess } from '@orca/process-host'

export async function writePluginAuthorTemplateFixture(
  directory: string,
  type: 'locale' | 'syntax' | 'viewer'
): Promise<void> {
  const result = await runProcess({
    program: process.execPath,
    args: [
      join(process.cwd(), 'plugin-packages', 'orca-plugin-tooling', 'src', 'cli.mjs'),
      'init',
      type,
      directory,
      '--publisher',
      'fixture-author',
      '--id',
      `template-${type}`
    ]
  })
  if (result.code !== 0) {
    throw new Error(result.stderr || 'author template creation failed')
  }
}
