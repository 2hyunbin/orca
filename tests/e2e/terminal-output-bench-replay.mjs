// Output producer for terminal-output-bench.spec.ts; runs inside an Orca PTY on every platform.
// usage: node terminal-output-bench-replay.mjs <nonce> <stampFile> <mode> [args...]
//   timed <fixture.json.gz> [speed]   replay recorded PTY reads at their recorded times
//   burst <fixture.json.gz|file.gz|file> write every byte as fast as the PTY accepts
//   yes <bytes> | seq <n> | flood     synthetic stress output (flood runs until Ctrl-C)
//   tui <seconds> <fps>                full-screen alt-screen repaint with a frame header
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const [nonce, stampFile, mode, ...args] = process.argv.slice(2);
const out = process.stdout;
const RESET =
  "\x1b[?1049l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1004l\x1b[?2004l\x1b[?2026l" +
  "\x1b[>4m\x1b[<u\x1b[r\x1b[0m\x1b[?25h";

if (process.stdin.isTTY) {
  // Recorded transcripts carry terminal queries; swallow the replies instead of echoing them.
  process.stdin.setRawMode(true);
  process.stdin.on("data", (data) => {
    if (data.includes(3)) {
      finish(130);
    }
  });
}

function write(data) {
  return out.write(data)
    ? Promise.resolve()
    : new Promise((r) => out.once("drain", r));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
let finishing = false;
function finish(code = 0) {
  if (finishing) {
    return;
  }
  finishing = true;
  out.write(`${RESET}\r\nDONE-${nonce}\r\n`, () => {
    writeFileSync(stampFile, String(Date.now()));
    setTimeout(() => process.exit(code), 150);
  });
}
function load(file) {
  const raw = readFileSync(file);
  const bytes = file.endsWith(".gz") ? gunzipSync(raw) : raw;
  return file.includes(".json") ? JSON.parse(bytes.toString("utf8")) : bytes;
}

async function main() {
  if (mode === "timed") {
    const speed = Number(args[1] ?? 1);
    const { chunks } = load(args[0]);
    const start = Date.now();
    for (const [at, b64] of chunks) {
      await sleep(start + at / speed - Date.now());
      await write(Buffer.from(b64, "base64"));
    }
  } else if (mode === "burst") {
    const loaded = load(args[0]);
    const bytes = Buffer.isBuffer(loaded)
      ? loaded
      : Buffer.concat(
          loaded.chunks.map(([, b64]) => Buffer.from(b64, "base64")),
        );
    for (let i = 0; i < bytes.length; i += 65536) {
      await write(bytes.subarray(i, i + 65536));
    }
  } else if (mode === "yes") {
    const block = Buffer.from("y\n".repeat(32768));
    let left = Number(args[0]);
    while (left > 0) {
      const part = block.subarray(0, Math.min(left, block.length));
      left -= part.length;
      await write(part);
    }
  } else if (mode === "seq") {
    const n = Number(args[0]);
    for (let i = 1; i <= n;) {
      let s = "";
      for (const end = Math.min(n, i + 8191); i <= end; i++) {
        s += `${i}\n`;
      }
      await write(s);
    }
  } else if (mode === "flood") {
    const block =
      "orca-bench-flood the quick brown fox jumps over the lazy dog 0123456789\n".repeat(
        512,
      );
    while (!finishing) {
      await write(block);
    }
    return;
  } else if (mode === "tui") {
    const seconds = Number(args[0]);
    const fps = Number(args[1]);
    const cols = out.columns || 80;
    const rows = out.rows || 24;
    await write("\x1b[?1049h\x1b[?25l");
    const start = Date.now();
    const frames = Math.round(seconds * fps);
    for (let f = 0; f < frames; f++) {
      await sleep(start + (f * 1000) / fps - Date.now());
      let frame = `\x1b[H\x1b[1;37;44m${`F ${f} ${Date.now()}`.padEnd(cols - 1)}\x1b[0m`;
      for (let r = 2; r <= rows; r++) {
        const text = `${r} ${"abcdefghijklmnopqrstuvwxyz".repeat(8)}`.slice(
          0,
          cols - 1,
        );
        frame += `\x1b[${r};1H\x1b[3${(f + r) % 7}m${text}\x1b[K`;
      }
      await write(frame);
    }
    writeFileSync(`${stampFile}.frames`, String(frames));
  } else {
    throw new Error(`unknown mode ${mode}`);
  }
  finish();
}
process.on("SIGINT", () => finish(130));
main();
