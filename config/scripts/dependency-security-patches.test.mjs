import { generateKeyPairSync } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runProcessSync } from '@orca/process-host'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolvePnpmCliInvocation } from './pnpm-cli-invocation.mjs'

const root = resolve(import.meta.dirname, '../..')
const scratch = mkdtempSync(join(tmpdir(), 'orca-security-patches-'))
const require = createRequire(join(scratch, 'package.json'))

beforeAll(() => {
  const packages = { braces: '3.0.3', 'sprintf-js': '1.1.3', 'node-forge': '1.4.0' }
  mkdirSync(join(scratch, 'patches'))
  const patches = Object.entries(packages).map(([name, version]) => {
    const file = `${name}@${version}.patch`
    const source = name === 'node-forge' ? 'mobile/patches' : 'config/patches'
    copyFileSync(join(root, source, file), join(scratch, 'patches', file))
    return `  ${name}@${version}: patches/${file}`
  })
  writeFileSync(
    join(scratch, 'package.json'),
    JSON.stringify({ private: true, dependencies: packages })
  )
  writeFileSync(
    join(scratch, 'pnpm-workspace.yaml'),
    `packages: []\npatchedDependencies:\n${patches.join('\n')}\n`
  )
  const { command, prefixArgs } = resolvePnpmCliInvocation()
  const result = runProcessSync({
    program: command,
    args: [...prefixArgs, 'install', '--ignore-scripts'],
    cwd: scratch,
    timeoutMs: 120_000
  })
  expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0)
}, 120_000)

afterAll(() => rmSync(scratch, { recursive: true, force: true }))

describe('dependency security patches applied by pnpm', () => {
  it.each(['compile', 'expand', 'stringify'])('bounds nested patterns in braces.%s', (method) => {
    const braces = require('braces')
    const pattern = `${'{'.repeat(4_000)}a,b${'}'.repeat(4_000)}`
    expect(() => braces[method](pattern)).toThrow('maximum nesting depth')
    expect(braces.expand('src/{main,shared}/*.ts')).toEqual(['src/main/*.ts', 'src/shared/*.ts'])
  })

  it.each(['compile', 'expand', 'stringify'])(
    'bounds directly supplied ASTs in braces.%s',
    (method) => {
      const braces = require('braces')
      let ast = { type: 'text', value: 'ok' }
      for (let depth = 0; depth < 10_000; depth += 1) {
        ast = { type: 'root', nodes: [ast] }
      }
      expect(() => braces[method](ast)).toThrow('maximum nesting depth')
    }
  )

  it.each(['src/sprintf.js', 'dist/sprintf.min.js'])('bounds numeric precision in %s', (entry) => {
    const { sprintf } = require(`sprintf-js/${entry}`)
    for (const type of ['e', 'f', 'g']) {
      expect(() => sprintf(`%.${'9'.repeat(500)}${type}`, 1.234)).not.toThrow()
      expect(sprintf(`%.${'9'.repeat(500)}${type}`, 1.234).length).toBeLessThan(110)
    }
    expect(sprintf('%.2f', 1.234)).toBe('1.23')
    expect(sprintf('%.2e', 1.234)).toBe('1.23e+0')
    expect(sprintf('%.2g', 1.234)).toBe('1.2')
    expect(sprintf('%.3s', 'abcdef')).toBe('abc')
    expect(sprintf('%.0f', 1.7)).toBe('2')
    expect(sprintf('%.0e', 1.7)).toBe('2e+0')
  })

  it('rejects extra nested DigestAlgorithm elements while accepting valid RSA signatures', () => {
    const forge = require('node-forge')
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024, publicExponent: 3 })
    const key = forge.pki.privateKeyFromPem(
      privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
    )
    const publicKey = forge.pki.setRsaPublicKey(key.n, key.e)
    const md = forge.md.sha256.create().update('release payload')
    const digest = md.digest().getBytes()
    expect(publicKey.verify(digest, key.sign(md))).toBe(true)
    const { asn1 } = forge
    const element = (type, value, constructed = false) =>
      asn1.create(asn1.Class.UNIVERSAL, type, constructed, value)
    const algorithm = element(
      asn1.Type.SEQUENCE,
      [
        element(asn1.Type.OID, asn1.oidToDer(forge.pki.oids.sha256).getBytes()),
        element(asn1.Type.NULL, ''),
        element(asn1.Type.OCTETSTRING, 'unexpected padding')
      ],
      true
    )
    const digestInfo = element(
      asn1.Type.SEQUENCE,
      [algorithm, element(asn1.Type.OCTETSTRING, digest)],
      true
    )
    const signature = key.sign(asn1.toDer(digestInfo).getBytes(), 'NONE')
    expect(() => publicKey.verify(digest, signature)).toThrow('DigestInfo')
  })
})
