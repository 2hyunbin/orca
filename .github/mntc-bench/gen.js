// Synthetic repo (LF): argv[2]=root, argv[3]=package count (40 => 50k files). Files avg ~2.7 KB.
const fs = require('fs'), path = require('path')
const root = process.argv[2], pkgs = +(process.argv[3] || 40)
let n = 0
function body(i) {
  const lines = [`// file ${i}`, `import { dep${i % 97} } from './dep${i % 97}'`]
  const count = 30 + ((i * 7) % 60)
  for (let k = 0; k < count; k++) lines.push(`export const v${k}_${i} = dep${i % 97}(${k}, '${(k * i).toString(36)}')`)
  if (i % 500 === 0) lines.push(`// ORCA_NEEDLE marker ${i}`)
  return lines.join('\n') + '\n'
}
function w(rel, s) { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); n++ }
for (let i = 0; i < 10000; i++) w(`src/big/f${String(i).padStart(5, '0')}.ts`, body(n))
for (let p = 0; p < pkgs; p++) for (const d of 'abcdefghij') for (let i = 0; i < 100; i++) w(`pkgs/p${String(p).padStart(2, '0')}/${d}/m${i}.ts`, body(n))
let big = '', j = 0
while (big.length < 5 * 1024 * 1024) big += `line ${j++} lorem ipsum dolor sit amet consectetur adipiscing elit sed do\n`
w('assets/big.txt', big)
w('README.md', '# bench\n')
console.log('files', n)
