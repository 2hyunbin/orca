import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'
import { parse } from 'yaml'

const release = parse(readFileSync('.github/workflows/release-cut.yml', 'utf8'))
const security = parse(readFileSync('.github/workflows/dependency-security.yml', 'utf8'))
const gate = release.jobs['dependency-security']
const publish = release.jobs['publish-release']

function evaluate(expression, tag, result) {
  const needs = Object.fromEntries(publish.needs.map((job) => [job, { result: 'success' }]))
  needs.cut.outputs = { tag, should_release: 'true' }
  needs['dependency-security'].result = result
  return runInNewContext(expression.replace(/needs\.([\w-]+)/g, 'needs["$1"]'), {
    needs,
    cancelled: () => false,
    contains: (value, part) => value.includes(part)
  })
}

it('blocks stable publication until its dependency scan succeeds while leaving RCs independent', () => {
  for (const tag of ['v1.5.0', 'v2.0.1']) {
    expect(evaluate(gate.if, tag, 'success')).toBe(true)
    expect(evaluate(publish.if, tag, 'success')).toBe(true)
    for (const result of ['failure', 'cancelled', 'skipped', '', undefined]) {
      expect(evaluate(publish.if, tag, result)).toBe(false)
    }
  }
  for (const tag of ['v1.5.0-rc.1', 'v1.5.0-rc.1.perf']) {
    expect(evaluate(gate.if, tag, 'skipped')).toBe(false)
    expect(evaluate(publish.if, tag, 'skipped')).toBe(true)
  }
})

it('scans the release tag with read-only workflow tooling instead of installing candidate code', () => {
  expect(gate.with.ref).toBe('refs/tags/${{ needs.cut.outputs.tag }}')
  expect(gate.uses).toBe('./.github/workflows/dependency-security.yml')
  expect(security.permissions).toEqual({ contents: 'read' })
  expect(security.on.schedule).toBeUndefined()
  for (const job of Object.values(security.jobs)) {
    const checkouts = job.steps.filter((step) => step.uses === 'actions/checkout@v6')
    expect(checkouts).toHaveLength(2)
    expect(checkouts[0].with.ref).toBe(
      "${{ inputs.ref != '' && github.workflow_sha || github.sha }}"
    )
    expect(checkouts[1].with).toMatchObject({
      ref: '${{ inputs.ref }}',
      path: 'candidate',
      'persist-credentials': false
    })
    expect(checkouts[1].if).toBe("inputs.ref != ''")
    for (const step of job.steps) {
      if (step.uses?.startsWith('./')) {
        expect(step['working-directory']).toBeUndefined()
        expect(step.with?.['working-directory']).toBeUndefined()
      }
    }
  }
})
