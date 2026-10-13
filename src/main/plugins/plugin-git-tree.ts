import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gitExecFileAsyncBuffer } from '../git/runner'
import {
  PLUGIN_TREE_MAX_BYTES,
  PLUGIN_TREE_MAX_ENTRIES
} from '../../shared/plugins/plugin-tree-limits'
import {
  parsePluginGitTree,
  PLUGIN_GIT_TREE_METADATA_MAX_BYTES,
  readPluginGitBatchBlobs
} from '../../shared/plugins/plugin-git-tree-format'

export async function materializePluginGitTree(input: {
  repository: string
  commit: string
  destination: string
}): Promise<void> {
  const options = { cwd: input.repository, timeout: 120_000 }
  const metadata = await gitExecFileAsyncBuffer(
    ['ls-tree', '-r', '-t', '-l', '-z', '--full-tree', input.commit],
    { ...options, maxBuffer: PLUGIN_GIT_TREE_METADATA_MAX_BYTES }
  )
  const entries = parsePluginGitTree(metadata.stdout)
  const objects = [
    ...new Set(entries.flatMap((entry) => (entry.kind === 'blob' ? [entry.object] : [])))
  ]
  const data = objects.length
    ? await gitExecFileAsyncBuffer(['cat-file', '--batch'], {
        ...options,
        maxBuffer: PLUGIN_TREE_MAX_BYTES + PLUGIN_TREE_MAX_ENTRIES * 128,
        stdin: `${objects.join('\n')}\n`
      })
    : { stdout: Buffer.alloc(0) }
  const blobs = readPluginGitBatchBlobs(data.stdout, entries)
  for (const entry of entries) {
    const target = join(input.destination, ...entry.path.split('/'))
    if (entry.kind === 'tree') {
      await mkdir(target)
    } else {
      const bytes = blobs.get(entry.object)
      if (!bytes || bytes.length !== entry.size) {
        throw new Error('missing plugin Git blob')
      }
      await writeFile(target, bytes, { flag: 'wx', mode: entry.executable ? 0o755 : 0o644 })
    }
  }
}
