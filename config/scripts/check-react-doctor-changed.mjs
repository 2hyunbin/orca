import { realpathSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { collectAddedLineRanges, overlapsAddedLines } from './check-changed-code-quality.mjs'
import { resolvePullRequestDiffBase } from './git-pull-request-diff-base.mjs'
import { runAuditTool } from './run-audit-tool.mjs'

function readCompleteReport(stdout) {
  const report = JSON.parse(stdout)
  if (
    report?.schemaVersion !== 3 ||
    report.ok !== true ||
    report.error !== null ||
    report.mode !== 'diff' ||
    report.baselineDegraded ||
    !Array.isArray(report.projects) ||
    !Array.isArray(report.diagnostics) ||
    (report.skippedProjects !== undefined &&
      (!Array.isArray(report.skippedProjects) || report.skippedProjects.length > 0)) ||
    report.projects.some(
      (project) =>
        project?.complete !== true ||
        typeof project.packageRoot !== 'string' ||
        !Array.isArray(project.skippedChecks) ||
        project.skippedChecks.length > 0 ||
        !Array.isArray(project.diagnostics)
    )
  ) {
    throw new Error('React Doctor did not return a complete diff report.')
  }
  if (
    report.diagnostics.length !==
    report.projects.reduce((count, project) => count + project.diagnostics.length, 0)
  ) {
    throw new Error('React Doctor returned inconsistent project diagnostics.')
  }
  return report
}

export function main(
  root = process.cwd(),
  requestedBase = process.argv.slice(2).find((argument) => argument !== '--') ??
    process.env.ORCA_CODE_QUALITY_BASE ??
    'origin/main',
  run = runAuditTool
) {
  root = realpathSync(root)
  const base = resolvePullRequestDiffBase(root, requestedBase)
  // Accept revision syntax, never shell fragments or option injection.
  if (!/^(?!-)[A-Za-z0-9._/@^~-]+$/.test(base)) {
    throw new Error(`Refusing to pass an unsafe diff base to React Doctor: ${base}`)
  }
  const { comparisonBase, rangesByFile } = collectAddedLineRanges(root, base, {
    includePath: (file) => /\.(?:[cm]?[jt]sx?|html)$/i.test(file)
  })
  const result = run(
    'react-doctor',
    [
      '.',
      '--yes',
      '--scope',
      'files',
      '--base',
      comparisonBase,
      '--include-untracked',
      '--no-dead-code',
      '--no-supply-chain',
      '--no-telemetry',
      '--blocking',
      'none',
      '--json'
    ],
    { root, stdio: 'pipe' }
  )
  if (result.code !== 0 || result.signal || result.timedOut || result.outputTruncated) {
    throw new Error(`React Doctor scan failed: ${result.stderr || result.signal || result.code}`)
  }
  const report = readCompleteReport(result.stdout)
  let failures = 0
  for (const project of report.projects) {
    for (const diagnostic of project.diagnostics) {
      if (
        typeof diagnostic?.filePath !== 'string' ||
        !['error', 'warning'].includes(diagnostic.severity) ||
        !Number.isInteger(diagnostic.line) ||
        diagnostic.line < 0 ||
        (diagnostic.endLine !== undefined &&
          (!Number.isInteger(diagnostic.endLine) || diagnostic.endLine < diagnostic.line))
      ) {
        throw new Error('React Doctor returned an invalid diagnostic span.')
      }
      const file = path
        .relative(root, path.resolve(realpathSync(project.packageRoot), diagnostic.filePath))
        .split(path.sep)
        .join('/')
      const ranges = rangesByFile.get(file)
      if (
        diagnostic.severity === 'error' &&
        ranges &&
        (diagnostic.line === 0 ||
          overlapsAddedLines(diagnostic.line, diagnostic.endLine ?? diagnostic.line, ranges))
      ) {
        console.error(
          `${file}:${diagnostic.line} ${diagnostic.plugin}/${diagnostic.rule}: ${diagnostic.message}`
        )
        failures += 1
      }
    }
  }
  console.log(`React Doctor changed-lines gate: ${failures} error(s).`)
  return failures > 0 ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
