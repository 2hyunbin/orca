import { describe, expect, it } from 'vitest'
import {
  evaluateDependencyReports,
  isLicenseAllowed,
  parseDependencyPolicy
} from './dependency-policy.mjs'
import { readDependencyCommand } from './check-dependencies.mjs'

const policyValue = {
  workspaces: ['.', 'mobile'],
  minimumSeverity: 'high',
  allowedLicenses: ['MIT', 'ISC'],
  advisoryExceptions: [],
  licenseExceptions: []
}
const licenses = { MIT: [{ name: 'example', versions: ['1.2.3'] }] }

function audit(severity = 'high', versions = ['1.2.3']) {
  return {
    advisories: {
      123: {
        module_name: 'example',
        github_advisory_id: 'GHSA-1234-5678-9abc',
        severity,
        title: 'Untrusted input can exhaust memory',
        url: 'https://github.com/advisories/GHSA-1234-5678-9abc',
        findings: versions.map((version) => ({ version, paths: ['.>build-tool>example'] }))
      }
    },
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, [severity]: 1 }
    }
  }
}

function policy(changes = {}) {
  return parseDependencyPolicy({ ...policyValue, ...changes }, '2026-10-21')
}

const exception = {
  workspace: '.',
  package: 'example',
  version: '1.2.3',
  reason: 'Build-time usage is limited to trusted input; remove after upstream fixes it',
  owner: 'Dependency maintainer',
  expires: '2026-11-01'
}

describe('dependency policy', () => {
  it.each([
    ['MIT OR GPL-3.0-only', true],
    ['MIT AND GPL-3.0-only', false],
    ['(MIT OR GPL-3.0-only) AND ISC', true],
    ['MIT AND (GPL-3.0-only OR AGPL-3.0-only)', false],
    ['MIT WITH LLVM-exception', false],
    ['MIT+', false],
    ['Unknown', false],
    ['SEE LICENSE IN LICENSE.md', false],
    ['MIT OR Unknown', false]
  ])('evaluates SPDX obligations for %s', (expression, expected) => {
    expect(isLicenseAllowed(expression, ['MIT', 'ISC'])).toBe(expected)
  })

  it('accepts an explicitly allowed license exception without accepting the bare license', () => {
    expect(
      isLicenseAllowed('Apache-2.0 WITH LLVM-exception', ['Apache-2.0 WITH LLVM-exception'])
    ).toBe(true)
    expect(isLicenseAllowed('Apache-2.0', ['Apache-2.0 WITH LLVM-exception'])).toBe(false)
  })

  it('blocks high findings through build dependencies and retains lower severity findings', () => {
    const high = evaluateDependencyReports(policy(), '.', audit(), licenses)
    expect(high.blocking).toEqual([
      expect.objectContaining({ package: 'example', severity: 'high' })
    ])
    const moderate = evaluateDependencyReports(policy(), '.', audit('moderate'), licenses)
    expect(moderate.blocking).toEqual([])
    expect(moderate.vulnerabilities).toHaveLength(1)
  })

  it('blocks missing license metadata and keeps package versions separate', () => {
    const report = evaluateDependencyReports(policy(), '.', audit('low'), {
      Unknown: [{ name: 'unlicensed', versions: ['1.0.0', '2.0.0'] }]
    })
    expect(report.packageVersions).toBe(2)
    expect(report.blocking).toEqual([
      expect.objectContaining({ package: 'unlicensed', version: '1.0.0', license: 'Unknown' }),
      expect.objectContaining({ package: 'unlicensed', version: '2.0.0', license: 'Unknown' })
    ])
  })

  it('retains license findings without letting them block a security-only release gate', () => {
    const inventory = { Unknown: [{ name: 'unlicensed', versions: ['1.0.0'] }] }
    const report = evaluateDependencyReports(policy(), '.', audit(), inventory, {
      securityOnly: true
    })
    expect(report.licenses).toHaveLength(1)
    expect(report.blocking).toEqual([expect.objectContaining({ severity: 'high' })])
    expect(
      evaluateDependencyReports(policy(), '.', audit('moderate'), inventory, {
        securityOnly: true
      }).blocking
    ).toEqual([])
  })

  it('limits advisory exceptions to the exact workspace, advisory, package and version', () => {
    const reviewed = policy({
      advisoryExceptions: [{ ...exception, advisory: 'GHSA-1234-5678-9abc' }]
    })
    const report = evaluateDependencyReports(
      reviewed,
      '.',
      audit('high', ['1.2.3', '2.0.0']),
      licenses
    )
    expect(report.blocking).toEqual([expect.objectContaining({ version: '2.0.0' })])
    expect(report.vulnerabilities[0].exception).toEqual(
      expect.objectContaining({ owner: exception.owner })
    )
    expect(evaluateDependencyReports(reviewed, 'mobile', audit(), licenses).blocking).toHaveLength(
      1
    )
    for (const change of [
      { module_name: 'another' },
      { github_advisory_id: 'GHSA-abcd-5678-9abc' }
    ]) {
      const other = audit()
      Object.assign(other.advisories[123], change)
      expect(evaluateDependencyReports(reviewed, '.', other, licenses).blocking).toHaveLength(1)
    }
  })

  it('limits license exceptions to the exact version and reported license', () => {
    const reviewed = policy({ licenseExceptions: [{ ...exception, license: 'Unknown' }] })
    const inventory = { Unknown: [{ name: 'example', versions: ['1.2.3', '2.0.0'] }] }
    expect(evaluateDependencyReports(reviewed, '.', audit('low'), inventory).blocking).toEqual([
      expect.objectContaining({ version: '2.0.0' })
    ])
    expect(
      evaluateDependencyReports(reviewed, 'mobile', audit('low'), inventory).blocking
    ).toHaveLength(2)
    expect(
      evaluateDependencyReports(reviewed, '.', audit('low'), {
        'GPL-3.0-only': [{ name: 'example', versions: ['1.2.3'] }]
      }).blocking
    ).toHaveLength(1)
  })

  it.each([
    { expires: '2026-10-21' },
    { expires: '2026-02-30' },
    { reason: '' },
    { owner: '' },
    { workspace: 'unscanned' }
  ])('rejects expired or incomplete exceptions: %j', (change) => {
    expect(() =>
      policy({ licenseExceptions: [{ ...exception, license: 'Unknown', ...change }] })
    ).toThrow()
  })

  it('rejects empty or incomplete scanner results instead of passing', () => {
    expect(() => evaluateDependencyReports(policy(), '.', {}, licenses)).toThrow()
    expect(() => evaluateDependencyReports(policy(), '.', audit(), {})).toThrow(
      'Empty license inventory'
    )
    const missing = audit()
    missing.advisories = {}
    expect(() => evaluateDependencyReports(policy(), '.', missing, licenses)).toThrow(
      'Incomplete vulnerability report'
    )
  })

  it('limits exception expiry blocking to the release workspace and security scope', () => {
    const value = {
      ...policyValue,
      advisoryExceptions: [
        { ...exception, advisory: 'GHSA-1234-5678-9abc', expires: '2026-10-20' }
      ],
      licenseExceptions: [
        { ...exception, workspace: 'mobile', license: 'Unknown', expires: '2026-10-20' }
      ]
    }
    expect(() =>
      parseDependencyPolicy(value, '2026-10-21', { workspaces: ['mobile'], securityOnly: true })
    ).not.toThrow()
    expect(() =>
      parseDependencyPolicy(value, '2026-10-21', { workspaces: ['.'], securityOnly: true })
    ).toThrow('Expired')
    expect(() => parseDependencyPolicy(value, '2026-10-21', { workspaces: ['mobile'] })).toThrow(
      'Expired'
    )
  })

  it.each([
    { code: 2 },
    { signal: 'SIGTERM' },
    { timedOut: true },
    { outputTruncated: true },
    { stdout: '{' },
    { stdout: '{"error":"registry unavailable"}', code: 1 }
  ])('fails on scanner errors even if finding exits are allowed: %j', (change) => {
    const result = {
      code: 0,
      signal: null,
      timedOut: false,
      stdout: JSON.stringify(audit()),
      stderr: '',
      ...change
    }
    expect(() => readDependencyCommand(result, true)).toThrow()
  })

  it('reads a valid nonzero audit report so vulnerabilities can be evaluated', () => {
    expect(readDependencyCommand({ code: 1, stdout: JSON.stringify(audit()) }, true)).toEqual(
      audit()
    )
  })
})
