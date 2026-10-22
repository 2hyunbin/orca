import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'

export function verifyAdvisoryExceptionPatches(policy, workspace, root) {
  const exceptions = policy.advisoryExceptions.filter(
    (item) => item.workspace === workspace && item.patch
  )
  if (exceptions.length === 0) {
    return
  }
  const cwd = resolve(root, workspace)
  const manifest = parse(readFileSync(resolve(cwd, 'pnpm-workspace.yaml'), 'utf8'))
  for (const item of exceptions) {
    const specifier = `${item.package}@${item.version}`
    if (manifest.patchedDependencies?.[specifier] !== item.patch.path) {
      throw new Error(`Advisory exception requires installed patch: ${workspace} ${specifier}`)
    }
    const bytes = readFileSync(resolve(cwd, item.patch.path))
    if (createHash('sha256').update(bytes).digest('hex') !== item.patch.sha256) {
      throw new Error(`Advisory exception patch changed: ${workspace} ${specifier}`)
    }
  }
}
