import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { readTrackedSources, runCountRatchet } from './ratchet-baseline.mjs'

// Ratchet on PTY retirements without exit proof (src/main/pty-exit-proof.ts). Each one drops the
// handle a later stop could use while the process may still run, so counts may only go down.

const BASELINE_PATH = 'config/unproven-pty-retirement-baseline.txt'
const SCAN_ROOTS = ['src']
const UNPROVEN_MINT = /\bPtyRetirementWithoutProof\.because\(/g
const COMMENT = /\/\*[\s\S]*?\*\/|(?<![:'"`\\])\/\/.*$/gm

export function isScannedPath(rel) {
  return /\.(ts|tsx)$/.test(rel) && !/\.(test|spec)\.tsx?$/.test(rel)
}

export function countUnprovenPtyRetirements(sourceText) {
  return sourceText.replace(COMMENT, ' ').match(UNPROVEN_MINT)?.length ?? 0
}

export function collectUnprovenPtyRetirementCounts(root = process.cwd()) {
  const counts = new Map()
  for (const [rel, source] of readTrackedSources(root, SCAN_ROOTS, isScannedPath)) {
    const count = countUnprovenPtyRetirements(source)
    if (count > 0) {
      counts.set(rel, count)
    }
  }
  return counts
}

export function main(root = process.cwd(), arg = undefined) {
  return runCountRatchet(
    {
      name: 'unproven-pty-retirement',
      baselinePath: BASELINE_PATH,
      header: [
        '# PTY retirements without exit proof (PtyRetirementWithoutProof.because) per file.',
        '# This is a RATCHET: counts may only go DOWN. Retire on a PtyExitProof, or record the stop',
        '# durably first. Prune after a fix: pnpm check:unproven-pty-retirement-ratchet --prune'
      ],
      collect: collectUnprovenPtyRetirementCounts,
      unit: 'unproven PTY retirement(s)',
      fix: [
        'Retire a PTY on a PtyExitProof from its owning host (src/main/pty-exit-proof.ts), or keep',
        'its ownership until one arrives. A close the host cannot answer must still read unverifiable.'
      ]
    },
    root,
    arg
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.cwd(), process.argv[2]))
}
