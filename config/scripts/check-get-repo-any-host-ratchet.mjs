import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import ts from 'typescript-api'
import {
  diffCounts,
  parseCountBaseline,
  pruneCountBaseline,
  readTrackedSources,
  totalCount
} from './ratchet-baseline.mjs'
import { isTestOnlySourcePath } from './test-only-source-path.mjs'

// Ratchet for the host-blind repo lookup. A repo id is not host-unique (the same id can be
// registered on local and on an SSH or runtime host), so `getRepoAnyHost(id)` returns whichever
// twin comes first. Per production file it counts every value use of `getRepoAnyHost` (calls,
// hand-offs, destructuring); declarations and types are not uses. Counts may only go down.

const BASELINE_PATH = 'config/get-repo-any-host-baseline.txt'
const SCAN_ROOTS = ['src/main', 'src/shared', 'src/cli']
const NAME = 'getRepoAnyHost'
const BASELINE_HEADER = [
  '# Production uses of the host-blind repo lookup `getRepoAnyHost`, per file.',
  '# This is a RATCHET: counts may only go DOWN. Use the host-scoped getRepo(repoId, hostId).',
  '# Prune after removing uses: pnpm check:get-repo-any-host-ratchet --prune'
]
const ADVICE =
  'A repo id can exist on several hosts; look the row up with getRepo(repoId, hostId) instead.'

function isDeclarationName(node) {
  const parent = node.parent
  return (
    (ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isFunctionDeclaration(parent)) &&
    parent.name === node
  )
}

/** Value uses of `getRepoAnyHost` in one source file. */
export function countGetRepoAnyHostUses(file, sourceText) {
  if (!sourceText.includes(NAME)) {
    return 0
  }
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true)
  let count = 0
  const visit = (node) => {
    if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) {
      return
    }
    if (ts.isIdentifier(node) && node.text === NAME && !isDeclarationName(node)) {
      count += 1
    } else if (
      ts.isStringLiteralLike(node) &&
      node.text === NAME &&
      ts.isElementAccessExpression(node.parent) &&
      node.parent.argumentExpression === node
    ) {
      count += 1
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return count
}

export function isScannedPath(rel) {
  return /\.[cm]?tsx?$/.test(rel) && !rel.endsWith('.d.ts') && !isTestOnlySourcePath(rel)
}

function readScannedSources(root) {
  return readTrackedSources(root, SCAN_ROOTS, isScannedPath)
}

/** `sources` maps repo-relative paths to text; unscanned paths in it are ignored. */
export function collectCurrentCounts(sources) {
  const counts = new Map()
  for (const [rel, text] of sources) {
    if (!isScannedPath(rel)) {
      continue
    }
    const found = countGetRepoAnyHostUses(rel, text)
    if (found > 0) {
      counts.set(rel, found)
    }
  }
  return counts
}

export function main(root = process.cwd(), sources = readScannedSources(root)) {
  const baselineFile = path.join(root, BASELINE_PATH)
  if (!fs.existsSync(baselineFile)) {
    console.error(`::error::Missing ${BASELINE_PATH}.`)
    return 1
  }
  const current = collectCurrentCounts(sources)
  const { grown, shrunk } = diffCounts(
    current,
    parseCountBaseline(fs.readFileSync(baselineFile, 'utf8'))
  )
  for (const { file, now, allowed } of grown) {
    console.error(
      `::error file=${file}::${now} getRepoAnyHost use(s), baseline allows ${allowed}. ${ADVICE}`
    )
  }
  for (const { file, now, allowed } of shrunk) {
    console.error(
      `::error file=${file}::${now} getRepoAnyHost use(s), baseline still allows ${allowed}. Run: pnpm check:get-repo-any-host-ratchet --prune`
    )
  }
  if (grown.length + shrunk.length > 0) {
    return 1
  }
  console.log(`getRepoAnyHost ratchet OK — ${totalCount(current)} use(s).`)
  return 0
}

export function prune(root = process.cwd(), sources = readScannedSources(root)) {
  const kept = pruneCountBaseline(
    root,
    BASELINE_PATH,
    BASELINE_HEADER,
    collectCurrentCounts(sources)
  )
  console.log(`Pruned ${BASELINE_PATH} to ${kept} use(s).`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = process.cwd()
  if (process.argv[2] === '--prune') {
    prune(root)
  }
  process.exit(main(root))
}
