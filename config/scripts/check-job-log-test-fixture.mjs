import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

export function readCheckLogFixture(root = process.cwd()) {
  const fixture = JSON.parse(
    readFileSync(
      path.join(root, 'src', 'shared', '__fixtures__', 'check-job-log-failure-output.json'),
      'utf8'
    )
  )
  for (const name of [
    'rawLog',
    'expectedDiagnostic',
    'expectedStackFrame',
    'benignMarker',
    'genericExitMarker',
    'escapeRefusalStderr'
  ]) {
    assert.equal(typeof fixture[name], 'string', `Invalid fixture field: ${name}`)
  }
  assert.equal(fixture.provenance.kind, 'scrubbed-job-excerpt')
  return fixture
}
