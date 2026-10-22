import parseSpdx from 'spdx-expression-parse'
import { z } from 'zod'

const text = z.string().trim().min(1)
const severity = z.enum(['info', 'low', 'moderate', 'high', 'critical'])
const severities = severity.options
const exception = z.object({
  workspace: text,
  package: text,
  version: text,
  reason: text,
  owner: text,
  expires: z.iso.date()
})
const policySchema = z.strictObject({
  workspaces: z.array(text).min(1),
  minimumSeverity: severity,
  allowedLicenses: z.array(text).min(1),
  advisoryExceptions: z.array(
    exception
      .extend({
        advisory: z.string().regex(/^GHSA-[-a-z0-9]+$/),
        patch: z.strictObject({ path: text, sha256: z.string().regex(/^[a-f0-9]{64}$/) }).optional()
      })
      .strict()
  ),
  licenseExceptions: z.array(exception.extend({ license: text }).strict())
})
const auditSchema = z.object({
  advisories: z.record(
    text,
    z.object({
      module_name: text,
      github_advisory_id: text,
      severity,
      title: text,
      url: z.url(),
      findings: z.array(z.object({ version: text, paths: z.array(text).min(1) })).min(1)
    })
  ),
  metadata: z.object({
    vulnerabilities: z.object(
      Object.fromEntries(severities.map((level) => [level, z.int().min(0)]))
    )
  })
})
const licensesSchema = z.record(
  text,
  z.array(z.object({ name: text, versions: z.array(text).min(1) })).min(1)
)

export function parseDependencyPolicy(
  value,
  today = new Date().toISOString().slice(0, 10),
  { workspaces, securityOnly = false } = {}
) {
  const policy = policySchema.parse(value)
  if (new Set(policy.workspaces).size !== policy.workspaces.length) {
    throw new Error('Dependency policy contains duplicate workspaces')
  }
  for (const license of policy.allowedLicenses) {
    parseSpdx(license)
  }
  for (const item of [...policy.advisoryExceptions, ...policy.licenseExceptions]) {
    if (!policy.workspaces.includes(item.workspace)) {
      throw new Error(`Exception names an unknown workspace: ${item.workspace}`)
    }
    if (
      (!workspaces || workspaces.includes(item.workspace)) &&
      (!securityOnly || 'advisory' in item) &&
      item.expires <= today
    ) {
      throw new Error(
        `Expired dependency exception: ${item.workspace} ${item.package}@${item.version}`
      )
    }
  }
  return policy
}

export function isLicenseAllowed(expression, allowedLicenses) {
  function allowed(node) {
    if (node.conjunction === 'or') {
      return allowed(node.left) || allowed(node.right)
    }
    if (node.conjunction === 'and') {
      return allowed(node.left) && allowed(node.right)
    }
    const license = `${node.license}${node.plus ? '+' : ''}${node.exception ? ` WITH ${node.exception}` : ''}`
    return allowedLicenses.includes(license)
  }
  try {
    return allowed(parseSpdx(expression))
  } catch {
    return false
  }
}

function findException(exceptions, workspace, finding, field) {
  return exceptions.find(
    (item) =>
      item.workspace === workspace &&
      item.package === finding.package &&
      item.version === finding.version &&
      item[field] === finding[field]
  )
}

export function evaluateDependencyReports(
  policy,
  workspace,
  auditValue,
  licensesValue,
  { securityOnly = false } = {}
) {
  const audit = auditSchema.parse(auditValue)
  const inventory = licensesSchema.parse(licensesValue)
  if (Object.keys(inventory).length === 0) {
    throw new Error('Empty license inventory')
  }
  const reportedCount = Object.values(audit.metadata.vulnerabilities).reduce((sum, n) => sum + n, 0)
  if (reportedCount !== Object.keys(audit.advisories).length) {
    throw new Error('Incomplete vulnerability report')
  }
  const vulnerabilities = []
  const licenses = []
  for (const advisory of Object.values(audit.advisories)) {
    for (const finding of advisory.findings) {
      const item = {
        advisory: advisory.github_advisory_id,
        package: advisory.module_name,
        version: finding.version,
        severity: advisory.severity,
        title: advisory.title,
        url: advisory.url,
        paths: finding.paths,
        blocking:
          severities.indexOf(advisory.severity) >= severities.indexOf(policy.minimumSeverity)
      }
      item.exception = findException(policy.advisoryExceptions, workspace, item, 'advisory')
      vulnerabilities.push(item)
    }
  }
  let packageVersions = 0
  for (const [license, packages] of Object.entries(inventory)) {
    for (const pkg of packages) {
      packageVersions += pkg.versions.length
      if (isLicenseAllowed(license, policy.allowedLicenses)) {
        continue
      }
      for (const version of pkg.versions) {
        const item = { package: pkg.name, version, license }
        item.exception = findException(policy.licenseExceptions, workspace, item, 'license')
        licenses.push(item)
      }
    }
  }
  const blocking = [
    ...vulnerabilities.filter((item) => item.blocking && !item.exception),
    ...(securityOnly ? [] : licenses.filter((item) => !item.exception))
  ]
  return { workspace, packageVersions, vulnerabilities, licenses, blocking }
}
