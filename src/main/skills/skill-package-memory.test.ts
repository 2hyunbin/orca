import { runProcess } from '@orca/process-host'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('creates and verifies a maximum-size CRLF skill within a 64 MiB heap', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-skill-package-memory-'))
  try {
    const child = join(root, 'skill-package.cjs')
    await build({
      stdin: {
        contents: `
          import { createSkillPackageArchive } from './src/main/skills/skill-package-creation';
          import { extractSkillPackageArchive } from './src/main/skills/skill-package-extraction';
          import { createHash } from 'node:crypto';
          import { mkdir, writeFile, readFile } from 'node:fs/promises';
          import { join } from 'node:path';
          (async () => {
            const root = process.argv[2];
            const sourceDirectory = join(root, 'skill');
            await mkdir(sourceDirectory);
            const prefix = '# dense-skill\\r\\n\\r\\nA short skill description.\\r\\n\\r\\n';
            const markdown = prefix + 'go\\r\\n'.repeat(Math.floor((4 * 1024 * 1024 - prefix.length) / 4));
            await writeFile(join(sourceDirectory, 'SKILL.md'), markdown);
            const created = await createSkillPackageArchive({ sourceDirectory,
              archivePath: join(root, 'package.tar.gz'), packageId: 'summary-package',
              versionId: 'summary-version', createdAt: '2026-01-01T00:00:00.000Z' });
            const extracted = await extractSkillPackageArchive({ archivePath: created.archivePath,
              destinationDirectory: join(root, 'extracted'), expectedArchiveSha256: created.archiveSha256,
              expectedPackageDigest: created.manifest.packageDigest });
            const bytes = await readFile(join(extracted.skillDirectory, 'SKILL.md'));
            console.log(JSON.stringify({
              name: created.manifest.name, description: created.manifest.description,
              archiveSha256: created.archiveSha256, packageDigest: created.manifest.packageDigest,
              extractedBytes: bytes.length, extractedSha256: createHash('sha256').update(bytes).digest('hex'),
              peakRss: process.resourceUsage().maxRSS * 1024
            }));
          })().catch(error => { console.error(error); process.exitCode = 1; });
        `,
        resolveDir: process.cwd()
      },
      outfile: child,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent',
      external: ['electron']
    })
    const result = await runProcess({
      program: process.execPath,
      args: ['--max-old-space-size=64', child, root],
      env: { ...process.env, NODE_OPTIONS: undefined, ORCA_BACKGROUND_LAUNCH: '1' },
      timeoutMs: 15_000,
      maxOutputBytes: 4096
    })
    expect(result.timedOut).toBe(false)
    expect(result.code, result.stderr).toBe(0)
    const output: {
      name: string
      description: string
      archiveSha256: string
      packageDigest: string
      extractedBytes: number
      extractedSha256: string
      peakRss: number
    } = JSON.parse(result.stdout)
    expect(output).toMatchObject({
      name: 'dense-skill',
      description: 'A short skill description.',
      archiveSha256: '7aad9b0875298df48462e391e6ff3e983a3cb0f473edb3f3a3c61506a6d2d0bf',
      packageDigest: '731816ae1b2fdf19a717bb65e515d2c5c64fda848adde0f0d8012d232a2cf4ac',
      extractedBytes: 4_194_303,
      extractedSha256: '6046071ff1ffeadd3d3709782d06854a683eafe1d1978425efdccd5f3cd44878'
    })
    expect(output.peakRss).toBeLessThan(200 * 1024 * 1024)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
