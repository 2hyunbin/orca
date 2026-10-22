import { readFileSync } from 'node:fs'
import { runProcessSync } from '@orca/process-host'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const workflow = (name) => parse(readFileSync(`.github/workflows/${name}.yml`, 'utf8'))
const scanner = workflow('release-dependency-security')
const cases = [
  ['release-cut', 'cut', 'desktop', '${{ needs.dependency-source.outputs.sha }}'],
  ['release-mac-build', 'build-mac', 'desktop', '${{ needs.dependency-source.outputs.sha }}'],
  ['mobile-ios-release', 'ios-build', 'mobile', '${{ github.sha }}'],
  ['mobile-android-release', 'android-build', 'mobile', '${{ github.sha }}'],
  ['docs', 'production', 'docs', '${{ needs.release_gate.outputs.commit_sha }}'],
  ['cloud-publish-relay-production', 'publish', 'cloud', '${{ github.sha }}'],
  ['cloud-push-deploy', 'deploy', 'cloud', '${{ inputs.source_sha }}']
]

describe('release dependency security boundaries', () => {
  it.each(cases)('gates %s / %s on the source it ships', (name, job, profile, sha) => {
    const jobs = workflow(name).jobs
    const gate = jobs['dependency-security']
    expect(gate.uses).toBe('./.github/workflows/release-dependency-security.yml')
    expect(gate.with.sha).toBe(sha)
    expect(gate.with.profile ?? 'desktop').toBe(profile)
    expect([jobs[job].needs].flat()).toContain('dependency-security')
    // Status functions disable GitHub's implicit success check.
    if (/always\(|cancelled\(|failure\(|success\(/.test(jobs[job].if ?? '')) {
      expect(jobs[job].if).toContain("needs.dependency-security.result == 'success'")
    }
    expect(gate.permissions ?? workflow(name).permissions).toEqual({ contents: 'read' })
    const checkout = jobs[job].steps.find((step) => step.uses?.startsWith('actions/checkout@'))
    // The push workflow keeps trusted rollout code at the workflow SHA and archives candidate cloud source.
    expect(checkout.with.ref).toBe(name === 'cloud-push-deploy' ? '${{ github.sha }}' : sha)
  })

  it('keeps an existing-digest mirror independent of source scan success', () => {
    const jobs = workflow('cloud-publish-relay-production').jobs
    expect(jobs['dependency-security'].if).toContain("inputs.mode == 'publish'")
    expect(jobs.publish.if).toContain(
      "inputs.mode == 'mirror-staging' && needs.dependency-security.result == 'skipped'"
    )
    expect(jobs.publish.if).not.toContain("needs.dependency-security.result == 'failure'")
  })

  it('uses current recovery checks even when releasing a tag predating the gate', () => {
    const steps = workflow('release-cut').jobs.cut.steps
    const checkout = steps.find((step) => step.name === 'Checkout trusted release recovery checks')
    const publish = steps.find((step) => step.id === 'publish_drafts')
    expect(checkout.with).toEqual({
      ref: '${{ github.workflow_sha }}',
      path: '.release-security',
      'persist-credentials': false
    })
    expect(steps.indexOf(checkout)).toBeLessThan(steps.indexOf(publish))
    expect(publish.run).toBe(
      'node .release-security/config/scripts/publish-complete-draft-releases.mjs'
    )
    expect(steps.find((step) => step.id === 'version').run).toContain(
      "from './.release-security/config/scripts/publish-complete-draft-releases.mjs'"
    )
  })

  it.each([
    ['desktop', ['.', 'mobile', 'config/audit-tools']],
    ['mobile', ['mobile']],
    ['docs', ['docs/site']],
    ['cloud', ['cloud']]
  ])('propagates scanner failure for the %s release scope', (profile, workspaces) => {
    const step = scanner.jobs.node.steps.find(
      (step) => step.name === 'Audit the release dependency graph'
    )
    const result = runProcessSync({
      program: 'bash',
      args: ['-e', '-c', `pnpm() { printf '%s\\n' "$@"; return 37; }\n${step.run}`],
      env: { PROFILE: profile }
    })
    expect(result.code).toBe(37)
    expect(result.stdout.trim().split('\n')).toEqual([
      'check:dependencies',
      '--root',
      'release-source',
      '--security-only',
      ...workspaces.flatMap((name) => ['--workspace', name])
    ])
  })

  it.each([
    ['main', 'desktop'],
    ['a'.repeat(40), 'unknown'],
    ['a'.repeat(40), 'desktop; exit 0']
  ])('refuses an unpinned source or invalid scope', (sha, profile) => {
    const step = scanner.jobs.node.steps[0]
    const result = runProcessSync({
      program: 'bash',
      args: ['-e', '-c', step.run],
      env: { SOURCE_SHA: sha, PROFILE: profile }
    })
    expect(result.code).not.toBe(0)
  })

  it('keeps scans read-only and Rust restricted to desktop releases', () => {
    expect(scanner.permissions).toEqual({ contents: 'read' })
    expect(scanner.jobs.rust.if).toBe("inputs.profile == 'desktop'")
    for (const job of Object.values(scanner.jobs)) {
      expect(job.steps.find((step) => step.name === 'Checkout security tooling').with).toEqual({
        ref: '${{ github.workflow_sha }}',
        'persist-credentials': false
      })
      expect(job.steps.find((step) => step.name === 'Checkout release source').with).toEqual({
        ref: '${{ inputs.sha }}',
        path: 'release-source',
        'persist-credentials': false
      })
      expect(
        job.steps.some(
          (step) =>
            step.env && Object.values(step.env).some((value) => String(value).includes('secrets.'))
        )
      ).toBe(false)
    }
  })
})
