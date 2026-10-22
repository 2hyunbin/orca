import { runProcessSync } from '@orca/process-host'
import { globSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { evaluateDependencyReports, parseDependencyPolicy } from './dependency-policy.mjs'
import { resolvePnpmCliInvocation } from './pnpm-cli-invocation.mjs'
import { verifyAdvisoryExceptionPatches } from './dependency-patch-exceptions.mjs'

const ROOT = resolve(import.meta.dirname, '../..')

export function readDependencyCommand(result, allowFindings = false) {
  if (
    result.signal ||
    result.timedOut ||
    result.outputTruncated ||
    (result.code !== 0 && !(allowFindings && result.code === 1))
  ) {
    throw new Error(`Dependency scan failed (${result.code}): ${result.stderr || result.stdout}`)
  }
  const value = JSON.parse(result.stdout)
  if (result.code === 1 && Object.keys(value.advisories ?? {}).length === 0) {
    throw new Error('Audit failed without a vulnerability report')
  }
  return value
}

function checkRustDependencies(reportDir, securityOnly, root) {
  const version = runProcessSync({ program: 'cargo', args: ['deny', '--version'], cwd: ROOT })
  if (version.code !== 0 || version.stdout.trim() !== 'cargo-deny 0.20.2') {
    throw new Error(
      'Install the pinned scanner: cargo install cargo-deny --locked --version 0.20.2'
    )
  }
  const manifests = globSync('native/*/Cargo.toml', { cwd: root })
  if (manifests.length === 0) {
    throw new Error('No native Rust manifests found')
  }
  let passed = true
  for (const manifest of manifests) {
    const result = runProcessSync({
      program: 'cargo',
      args: [
        'deny',
        '--manifest-path',
        join(root, manifest),
        '--locked',
        '--config',
        join(ROOT, 'config/cargo-deny.toml'),
        'check',
        ...(securityOnly ? ['advisories'] : [])
      ],
      cwd: root,
      timeoutMs: 10 * 60_000,
      maxOutputBytes: 32 * 1024 * 1024
    })
    const name = manifest.split(/[\\/]/).at(-2)
    writeFileSync(join(reportDir, `${name}.log`), result.stdout + result.stderr)
    console.log(`${manifest}:\n${result.stdout}${result.stderr}`)
    if (result.code !== 0 || result.signal || result.timedOut || result.outputTruncated) {
      passed = false
    }
  }
  return passed ? 0 : 1
}

function pnpm(args, cwd, stdio = 'pipe') {
  const { command, prefixArgs } = resolvePnpmCliInvocation()
  return runProcessSync({
    program: command,
    args: [...prefixArgs, ...args],
    cwd,
    stdio,
    timeoutMs: 10 * 60_000,
    maxOutputBytes: 32 * 1024 * 1024
  })
}

function checkWorkspace(policy, workspace, reportDir, securityOnly, root) {
  verifyAdvisoryExceptionPatches(policy, workspace, root)
  const cwd = resolve(root, workspace)
  const slug = workspace === '.' ? 'desktop' : workspace.replaceAll('/', '-')
  const report = {
    workspace,
    platform: process.platform,
    arch: process.arch,
    checkedAt: new Date().toISOString(),
    errors: []
  }
  const install = pnpm(['install', '--frozen-lockfile', '--ignore-scripts'], cwd, 'inherit')
  if (install.code !== 0 || install.signal || install.timedOut) {
    report.errors.push('Frozen, script-free dependency install failed')
  } else {
    for (const { key, args } of [
      { key: 'audit', args: ['audit', '--json'] },
      { key: 'inventory', args: ['licenses', 'list', '--json'] }
    ]) {
      try {
        report[key] = readDependencyCommand(pnpm(args, cwd), key === 'audit')
      } catch (error) {
        report.errors.push(`${key}: ${String(error.message)}`)
      }
    }
    if (report.errors.length === 0) {
      try {
        report.result = evaluateDependencyReports(
          policy,
          workspace,
          report.audit,
          report.inventory,
          {
            securityOnly
          }
        )
      } catch (error) {
        report.errors.push(`Invalid dependency report: ${error.message}`)
      }
    }
  }
  writeFileSync(join(reportDir, `${slug}.json`), `${JSON.stringify(report, null, 2)}\n`)
  for (const error of report.errors) {
    console.error(`${workspace}: ${String(error)}`)
  }
  if (report.result) {
    const { packageVersions, vulnerabilities, licenses, blocking } = report.result
    console.log(
      `${workspace}: ${packageVersions} package versions; ${vulnerabilities.length} vulnerabilities; ${licenses.length} licenses requiring review; ${blocking.length} blockers`
    )
    for (const item of [...vulnerabilities, ...licenses]) {
      const label = item.exception ? `EXCEPTION until ${item.exception.expires}` : 'FINDING'
      console.log(
        `  ${label} ${item.package}@${item.version}: ${item.advisory ? `${item.severity} ${item.advisory} ${item.url}` : item.license}`
      )
    }
  }
  return report.errors.length === 0 && report.result.blocking.length === 0
}

export function checkDependencies(args) {
  const { values } = parseArgs({
    args,
    options: {
      workspace: { type: 'string', multiple: true },
      root: { type: 'string' },
      'report-dir': { type: 'string', default: 'tmp/dependency-policy' },
      rust: { type: 'boolean', default: false },
      'security-only': { type: 'boolean', default: false }
    }
  })
  const root = values.root ? resolve(ROOT, values.root) : ROOT
  const reportDir = resolve(ROOT, values['report-dir'])
  mkdirSync(reportDir, { recursive: true })
  if (values.rust) {
    if (values.workspace) {
      throw new Error('--rust cannot select pnpm workspaces')
    }
    return checkRustDependencies(reportDir, values['security-only'], root)
  }
  const policy = parseDependencyPolicy(
    JSON.parse(readFileSync(join(ROOT, 'config/dependency-policy.json'))),
    undefined,
    { workspaces: values.workspace, securityOnly: values['security-only'] }
  )
  const workspaces = values.workspace ?? policy.workspaces
  for (const workspace of workspaces) {
    if (!policy.workspaces.includes(workspace)) {
      throw new Error(`Unknown workspace: ${workspace}`)
    }
  }
  let passed = true
  for (const workspace of workspaces) {
    console.log(`Checking dependencies: ${workspace}`)
    try {
      if (!checkWorkspace(policy, workspace, reportDir, values['security-only'], root)) {
        passed = false
      }
    } catch (error) {
      passed = false
      console.error(`${workspace}: ${error.message}`)
    }
  }
  console.log(`Dependency reports: ${reportDir}`)
  return passed ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = checkDependencies(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
