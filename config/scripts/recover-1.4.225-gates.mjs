import { readFileSync, existsSync } from 'node:fs'

const repo = 'stablyai/orca'
const runId = 38611259486
const tag = 'v1.4.225'
const token = process.env.GH_TOKEN
if (!token) {
  throw new Error('GH_TOKEN is required')
}
async function api(path) {
  const response = await fetch(`https://api.github.com/repos/${repo}/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }
  })
  if (!response.ok) {
    throw new Error(`GitHub ${response.status}: ${path}`)
  }
  return response.json()
}
const run = await api(`actions/runs/${runId}`)
if (
  run.status !== 'completed' ||
  run.conclusion !== 'failure' ||
  run.run_attempt !== 1 ||
  run.path !== '.github/workflows/release-cut.yml' ||
  run.head_sha !== '38255300d90059631996e4d836acaf220958058e'
) {
  throw new Error('Original release run changed or is not the expected failed cut')
}
const { jobs } = await api(`actions/runs/${runId}/jobs?per_page=100`)
const windows = jobs.find((job) => job.id === 116026943989)
if (!windows || windows.conclusion !== 'failure') {
  throw new Error('Unexpected Windows result')
}
const failedSteps = windows.steps.filter((step) => step.conclusion === 'failure')
if (failedSteps.length !== 1 || failedSteps[0].name !== 'Verify Windows inner binary signatures') {
  throw new Error('Windows failed beyond the known compatibility check')
}
for (const name of [
  'Build app',
  'Build Windows release artifacts',
  'Verify Windows node-pty ConPTY runtime',
  'Download signed inner binaries from SignPath',
  'Restore signed inner binaries into unpacked app',
  'Restore signed uninstaller for the installer rebuild',
  'Rebuild NSIS installer from signed unpacked app',
  'Download signed Windows installer from SignPath',
  'Verify signed Windows installer'
]) {
  if (!windows.steps.some((step) => step.name === name && step.conclusion === 'success')) {
    throw new Error(`Original Windows prerequisite did not pass: ${name}`)
  }
}
const allowedSkipped = new Set([
  'homebrew-bump-published-rc-draft',
  'orcad-template / changes',
  'publish-release',
  'docs-production-dispatch',
  'post-release-e2e',
  'homebrew-bump'
])
for (const job of jobs) {
  if (job.id === windows.id) {
    continue
  }
  if (job.conclusion === 'success') {
    continue
  }
  if (job.conclusion === 'skipped' && allowedSkipped.has(job.name)) {
    continue
  }
  throw new Error(`Original release gate did not pass: ${job.name} (${job.conclusion})`)
}
for (const name of [
  'cut',
  'create-release',
  'release-preflight',
  'build-mac',
  'release-javascript / bundle',
  'golden e2e linux',
  'golden e2e mac',
  'golden e2e windows',
  'skill sharing release gate windows',
  'skill sharing release gate mac',
  'skill sharing release gate linux-glibc-2.31',
  'orcad-template / desktop_template'
]) {
  if (!jobs.some((job) => job.name === name && job.conclusion === 'success')) {
    throw new Error(`Missing release gate: ${name}`)
  }
}
if (
  jobs.filter((job) => job.name.startsWith('build (') && job.conclusion === 'success').length !== 2
) {
  throw new Error('Both original Linux builds must have passed')
}
const ref = await api(`git/ref/tags/${tag}`)
if (ref.object.sha !== '8f09327d816e715c45b49f610efcf7bf748a683d') {
  throw new Error('Release tag moved')
}
const annotatedTag = await api(`git/tags/${ref.object.sha}`)
if (annotatedTag.object.sha !== 'd22f72308106ef62f558cbde16dacb1f21031ae3') {
  throw new Error('Release source changed')
}
const releases = await api('releases?per_page=100')
const release = releases.find((candidate) => candidate.tag_name === tag)
if (!release || !release.draft) {
  throw new Error('Expected unpublished release draft')
}
const latest = await api('releases/latest')
if (latest.tag_name !== 'v1.4.224') {
  throw new Error('Stable release advanced; recovery needs reassessment')
}
if (existsSync('original-evidence/inner-signing-evidence.txt')) {
  const lines = readFileSync('original-evidence/inner-signing-evidence.txt', 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
  const verdict = lines.pop()
  if (
    verdict !== 'VERDICT: FAILED — Windows inner-binary evidence gate found 1 problems.' ||
    lines.length < 40 ||
    lines.some((line) => !/^Valid\s+.+<CN=SignPath Foundation,/.test(line))
  ) {
    throw new Error('Original signing evidence contains unexpected failures')
  }
}
console.log(`Verified original release gates, unchanged ${tag}, draft state and stable version`)
