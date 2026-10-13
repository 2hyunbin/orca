import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function writePluginHostileViewerFixture(directory: string): Promise<void> {
  await writeFile(
    join(directory, 'dist', 'sample.worker.js'),
    `
let lines = ['Viewer ready'];
const retained = [];
orcaViewer.register({
  async open(document) {
    const bytes = await orcaViewer.readBytes(0, Math.max(1, document.size));
    const mode = new TextDecoder().decode(bytes).trim();
    if (mode === 'memory') {
      lines = ['Allocation probe started'];
      setTimeout(function grow() {
        if (retained.length === 16) return;
        const buffer = new Uint8Array(64 * 1024 * 1024);
        buffer.fill(109);
        retained.push(buffer);
        setTimeout(grow, 25);
      }, 100);
    } else if (mode === 'idle-loop') {
      lines = ['Idle loop probe started'];
      setTimeout(() => { while (true) {} }, 500);
    } else if (mode === 'flood') {
      lines = ['Flood probe started'];
      setTimeout(() => { for (let index = 0; index < 2048; index++) postMessage({invalid:index}); }, 500);
    } else if (mode === 'api') {
      lines = ['Opened-file-only API probe'];
      for (const key of ['document', 'process', 'require', 'Buffer', 'orcaFileViewerHost', 'fetch', 'WebSocket', 'WebTransport', 'Worker', 'SharedWorker', 'importScripts']) {
        lines.push(key + ': ' + typeof globalThis[key]);
      }
      try {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', 'https://orca-viewer-security-probe.invalid/private');
        const result = await new Promise((resolve) => {
          xhr.onload = () => resolve('allowed');
          xhr.onerror = () => resolve('blocked');
          try { xhr.send(); } catch { resolve('blocked'); }
          setTimeout(() => resolve('timeout'), 1000);
        });
        lines.push('XMLHttpRequest: ' + result);
      } catch { lines.push('XMLHttpRequest: blocked'); }
      try { indexedDB.open('private'); lines.push('indexedDB: allowed'); }
      catch { lines.push('indexedDB: blocked'); }
      try { await caches.open('private'); lines.push('caches: allowed'); }
      catch { lines.push('caches: blocked'); }
    } else {
      lines = ['Recovered document', 'Fresh approved parser session'];
    }
    return {kind:'text',lineCount:lines.length};
  },
  render(viewport) {
    return {kind:'text',startLine:viewport.startLine,lines:lines.slice(viewport.startLine,viewport.startLine+viewport.lineCount)};
  }
});`
  )
}
