import type React from 'react'
import {
  Cloud,
  Container,
  Database,
  Download,
  FlaskConical,
  Hammer,
  Package,
  RefreshCw,
  type LucideIcon
} from 'lucide-react'
import { AgentLetterIcon } from './agent-icon-glyphs'
import { ProgramGlyph, type ProgramGlyphId } from './program-icon-glyphs'

const PROGRAM_GLYPHS: ReadonlyMap<string, ProgramGlyphId> = new Map(
  Object.entries({
    brew: 'homebrew',
    homebrew: 'homebrew',
    cargo: 'rust',
    rustc: 'rust',
    rustup: 'rust',
    npm: 'npm',
    npx: 'npm',
    pnpm: 'pnpm',
    yarn: 'yarn',
    bun: 'bun',
    bunx: 'bun',
    deno: 'deno',
    node: 'nodedotjs',
    terraform: 'terraform',
    tofu: 'opentofu',
    opentofu: 'opentofu',
    docker: 'docker',
    kubectl: 'kubernetes',
    k9s: 'kubernetes',
    helm: 'helm',
    git: 'git',
    gradle: 'gradle',
    gradlew: 'gradle',
    go: 'go',
    python: 'python',
    python3: 'python',
    pip: 'python',
    pip3: 'python',
    uv: 'uv',
    uvx: 'uv',
    poetry: 'poetry',
    ruby: 'ruby',
    gem: 'ruby',
    bundle: 'ruby',
    bundler: 'ruby',
    rake: 'ruby',
    php: 'php',
    composer: 'php',
    swift: 'swift',
    flutter: 'flutter',
    dart: 'dart',
    gcloud: 'googlecloud',
    gsutil: 'googlecloud',
    vercel: 'vercel',
    cmake: 'cmake'
  } satisfies Record<string, ProgramGlyphId>)
)

const PROGRAM_CATEGORY_ICONS = {
  package: Package,
  build: Hammer,
  container: Container,
  cloud: Cloud,
  sync: RefreshCw,
  download: Download,
  database: Database,
  test: FlaskConical
} satisfies Record<string, LucideIcon>

type ProgramCategory = keyof typeof PROGRAM_CATEGORY_ICONS

const PROGRAM_CATEGORIES: ReadonlyMap<string, ProgramCategory> = new Map(
  (
    [
      [
        'package',
        [
          'apt',
          'apt-get',
          'dnf',
          'yum',
          'pacman',
          'zypper',
          'port',
          'nix',
          'pipx',
          'conda',
          'mamba'
        ]
      ],
      [
        'build',
        [
          'make',
          'gmake',
          'ninja',
          'bazel',
          'mvn',
          'msbuild',
          'dotnet',
          'webpack',
          'vite',
          'tsc',
          'esbuild',
          'turbo',
          'nx'
        ]
      ],
      ['container', ['podman', 'nerdctl']],
      ['cloud', ['aws', 'az', 'fly', 'flyctl', 'netlify', 'pulumi', 'heroku', 'wrangler']],
      ['sync', ['rsync', 'rclone', 'unison']],
      ['download', ['curl', 'wget', 'aria2c']],
      ['database', ['psql', 'mysql', 'redis-cli', 'sqlite3']],
      ['test', ['pytest', 'jest', 'vitest', 'playwright']]
    ] satisfies [ProgramCategory, string[]][]
  ).flatMap(([category, ids]) => ids.map((id) => [id, category] as const))
)

function isKnownProgramId(id: string): boolean {
  return PROGRAM_GLYPHS.has(id) || PROGRAM_CATEGORIES.has(id)
}

/** Lowercases and strips a trailing version (`python-3.12`, `node@20`, `pip3.11`, `go1.21`). */
export function normalizeProgramId(program: string): string {
  const id = program
    .trim()
    .toLowerCase()
    .replace(/[-@]v?\d[\d.]*$/, '')
    .replace(/(\d)\.\d[\d.]*$/, '$1')
  // Why only toward a known id: trailing digits are often the name itself (`k9s`, `sqlite3`, `s3`).
  const unversioned = id.replace(/\d+$/, '')
  return !isKnownProgramId(id) && isKnownProgramId(unversioned) ? unversioned : id
}

function programLetter(program: string): string {
  return program.match(/[A-Za-z0-9]/)?.[0]?.toUpperCase() ?? '?'
}

export function ProgramIcon({
  program,
  size = 14
}: {
  program: string
  size?: number
}): React.JSX.Element {
  const id = normalizeProgramId(program)
  const glyph = PROGRAM_GLYPHS.get(id)
  if (glyph) {
    return <ProgramGlyph glyph={glyph} size={size} />
  }
  const category = PROGRAM_CATEGORIES.get(id)
  if (category) {
    const CategoryIcon = PROGRAM_CATEGORY_ICONS[category]
    // Why text-current: same opt-out of shadcn's Select svg recolor as ProgramGlyph.
    return <CategoryIcon size={size} className="text-current" aria-hidden />
  }
  return <AgentLetterIcon letter={programLetter(program)} size={size} />
}
