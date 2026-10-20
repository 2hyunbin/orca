import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  findAppSpeechRecognizerDir,
  stageSpeechRecognizerForOrcad
} from './serve-speech-recognizer'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-serve-speech-'))
  roots.push(root)
  return root
}

function recognizerAt(dir: string, version = '1.12.37'): string {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'sherpa-onnx.node'), 'addon')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }))
  return dir
}

// A packaged app root is `resources/app.asar.unpacked`; the recognizer sits in `resources/node_modules`.
describe("finding the app's speech recognizer (#31174)", () => {
  it('finds the copy a packaged app ships in its resources', () => {
    const resources = tempRoot()
    const dir = recognizerAt(join(resources, 'node_modules', 'sherpa-onnx-linux-x64'))
    expect(findAppSpeechRecognizerDir(join(resources, 'app.asar.unpacked'), 'linux', 'x64')).toBe(
      dir
    )
  })

  it('answers nothing when the app ships no recognizer for this platform', () => {
    const resources = tempRoot()
    recognizerAt(join(resources, 'node_modules', 'sherpa-onnx-linux-arm64'))
    expect(
      findAppSpeechRecognizerDir(join(resources, 'app.asar.unpacked'), 'linux', 'x64')
    ).toBeUndefined()
  })
})

describe('staging the recognizer for orcad', () => {
  it("hands orcad the app's own copy off Windows", () => {
    const app = recognizerAt(join(tempRoot(), 'sherpa-onnx-linux-x64'))
    expect(stageSpeechRecognizerForOrcad(app, tempRoot(), 'linux')).toBe(app)
  })

  // A loaded addon is locked on Windows; orcad holding the app's copy would block app updates.
  it('copies it into the profile once per version on Windows', () => {
    const app = recognizerAt(join(tempRoot(), 'sherpa-onnx-win-x64'))
    const profile = tempRoot()
    const staged = stageSpeechRecognizerForOrcad(app, profile, 'win32')
    expect(staged).toBe(join(profile, 'speech-recognizer', 'sherpa-onnx-win-x64-1.12.37'))
    expect(readFileSync(join(staged!, 'sherpa-onnx.node'), 'utf8')).toBe('addon')

    writeFileSync(join(app, 'sherpa-onnx.node'), 'changed')
    expect(stageSpeechRecognizerForOrcad(app, profile, 'win32')).toBe(staged)
    expect(readFileSync(join(staged!, 'sherpa-onnx.node'), 'utf8')).toBe('addon')

    recognizerAt(app, '1.13.0')
    const next = stageSpeechRecognizerForOrcad(app, profile, 'win32')
    expect(next).toBe(join(profile, 'speech-recognizer', 'sherpa-onnx-win-x64-1.13.0'))
    expect(existsSync(join(next!, 'sherpa-onnx.node'))).toBe(true)
    // The superseded copy is pruned once nothing holds it.
    expect(existsSync(staged!)).toBe(false)
  })

  it('leaves orcad cloud-only when the copy cannot be made', () => {
    const app = recognizerAt(join(tempRoot(), 'sherpa-onnx-win-x64'))
    writeFileSync(join(app, 'package.json'), '{}')
    expect(stageSpeechRecognizerForOrcad(app, tempRoot(), 'win32')).toBeUndefined()
  })
})
