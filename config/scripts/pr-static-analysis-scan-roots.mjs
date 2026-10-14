import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const STATIC_ANALYSIS_AUDIT_SCRIPTS = [
  'audit:code-quality:native',
  'audit:code-quality:type-aware',
  'audit:anti-slop'
]

// Positional arguments of an oxlint invocation are the trees it lints. `--config` consumes the
// next token; every other flag here is valueless.
function oxlintScanRoots(command) {
  const roots = []
  for (const segment of command.split('&&')) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean)
    if (tokens[0] !== 'oxlint') {
      continue
    }
    for (let index = 1; index < tokens.length; index += 1) {
      if (tokens[index] === '--config') {
        index += 1
      } else if (!tokens[index].startsWith('-')) {
        roots.push(tokens[index])
      }
    }
  }
  return roots
}

// Why derived from the commands rather than listed here: `mobile/` is desktop-irrelevant for every
// other job, yet these audits lint it. A second, hand-maintained copy of "which trees the gate
// reads" is what let #20702 land violations no PR check ran, so read it off the argv instead.
function readStaticAnalysisScanRoots() {
  const manifest = join(import.meta.dirname, '../../package.json')
  const { scripts = {} } = JSON.parse(readFileSync(manifest, 'utf8'))
  return [
    ...new Set(
      STATIC_ANALYSIS_AUDIT_SCRIPTS.flatMap((name) => oxlintScanRoots(scripts[name] ?? ''))
    )
  ]
}

export const STATIC_ANALYSIS_SCAN_ROOTS = readStaticAnalysisScanRoots()
