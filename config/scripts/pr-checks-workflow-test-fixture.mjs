import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse } from 'yaml'

export const projectDir = resolve(import.meta.dirname, '../..')
export const prWorkflow = parse(readFileSync(join(projectDir, '.github/workflows/pr.yml'), 'utf8'))

export const expensiveJobs = [
  'static_analysis',
  'typecheck',
  'git_compatibility',
  'codex_index_heal_contract',
  'xterm_patch_sync',
  'shell_contracts',
  'test',
  'orcad_browser',
  'cross-version-wire',
  'managed_hook_node18',
  'package',
  'package_windows'
]
