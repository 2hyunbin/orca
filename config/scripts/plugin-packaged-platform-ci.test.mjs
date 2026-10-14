import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { parse } from 'yaml'
import { classifyPrJobs } from './pr-code-change-scope.mjs'

const workflow = parse(readFileSync('.github/workflows/pr.yml', 'utf8'))

it('qualifies the actual Windows package with the format, locale, grammar and hostile-parser journeys', () => {
  const job = workflow.jobs.package_windows
  const steps = job.steps
  const packageIndex = steps.findIndex((step) => step.name === 'Package unpacked app')
  const journeyIndex = steps.findIndex(
    (step) => step.name === 'Verify Windows packaged plugin journeys'
  )
  const journey = steps[journeyIndex]
  expect(job['runs-on']).toBe('windows-2022')
  expect(packageIndex).toBeGreaterThan(-1)
  expect(journeyIndex).toBeGreaterThan(packageIndex)
  expect(journey.env.ORCA_PHASE_O_1_PACKAGED_EXECUTABLE).toBe(
    '${{ github.workspace }}/dist/win-unpacked/Orca.exe'
  )
  expect(journey.env.ORCA_BACKGROUND_LAUNCH).toBe('1')
  expect(journey.env.SKIP_BUILD).toBe('1')
  expect(journey.env.ORCA_PLUGIN_EVIDENCE_DIR).toBe(
    'reports/plugin-system/evidence/windows-packaged'
  )
  for (const spec of [
    'plugin-git-object-format',
    'plugin-packaged-cohort',
    'plugin-packaged-parser-recovery'
  ]) {
    expect(journey.run).toContain(`tests/e2e/${spec}.spec.ts`)
  }
  expect(journey.run).toContain('--project electron-headless --workers=1')
  expect(journey['continue-on-error']).toBeUndefined()
  expect(journey.if).toBeUndefined()
})

it('retains Windows native evidence on success or failure and keeps it separate from Linux', () => {
  const artifact = workflow.jobs.package_windows.steps.find(
    (step) => step.name === 'Upload Windows packaged plugin evidence'
  )
  expect(artifact.if).toBe('always()')
  expect(artifact.uses).toBe('actions/upload-artifact@v7')
  expect(artifact.with.name).toBe('windows-packaged-plugin-evidence')
  expect(artifact.with.path).toContain('test-results/')
  expect(artifact.with.path).toContain('reports/plugin-system/evidence/windows-packaged/')
  expect(artifact.with.name).not.toBe('packaged-plugin-evidence')
  expect(classifyPrJobs(['.github/workflows/pr.yml']).package_windows).toBe(true)
})
