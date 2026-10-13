import { createPluginViewerWorkerBootstrap } from '../../shared/plugins/plugin-viewer-worker-bootstrap'

export function pluginViewerWorkerProbePage(networkHost: string): string {
  if (!/^[a-z0-9-]+\.invalid$/i.test(networkHost)) {
    throw new Error('invalid probe host')
  }
  const author = String.raw`
  function globalThis() {}
  onmessage = (event) => {
    if (event.data === 'block') { while (true) {} }
  };
  let nestedDenied = false;
  try { new self.Worker('blob:null/fake'); } catch { nestedDenied = true; }
  let restoreDenied = false;
  try { Object.defineProperty(self, 'Worker', { value: () => {} }); } catch { restoreDenied = true; }
  const report = {
    documentType: typeof document,
    workerType: typeof self.Worker,
    fetchType: typeof self.fetch,
    webSocketType: typeof self.WebSocket,
    importScriptsType: typeof self.importScripts,
    nestedDenied,
    restoreDenied
  };
  const xhr = new XMLHttpRequest();
  xhr.onerror = () => postMessage({ ...report, xhrDenied: true });
  xhr.onload = () => postMessage({ ...report, xhrDenied: false });
  try {
    xhr.open('GET', 'https://${networkHost}/unavailable');
    xhr.send();
  } catch {
    postMessage({ ...report, xhrDenied: true });
  }`
  const placeholder = 'blob:null/00000000-0000-4000-8000-000000000000'
  const bootstrap = createPluginViewerWorkerBootstrap(placeholder)
  const child = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:; connect-src 'none'; object-src 'none'; frame-src 'none'">
  <script>
  const authorUrl = URL.createObjectURL(new Blob([${JSON.stringify(author)}], { type: 'text/javascript' }));
  const bootstrap = ${JSON.stringify(bootstrap)}.replaceAll(${JSON.stringify(placeholder)}, authorUrl);
  const bootstrapUrl = URL.createObjectURL(new Blob([bootstrap], { type: 'text/javascript' }));
  const worker = new Worker(bootstrapUrl);
  worker.onmessage = (event) => {
    parent.postMessage({ type: 'worker-proof', report: event.data }, '*');
    worker.postMessage('block');
    setTimeout(() => {
      worker.terminate();
      parent.postMessage({ type: 'worker-terminated' }, '*');
      URL.revokeObjectURL(authorUrl);
      URL.revokeObjectURL(bootstrapUrl);
    }, 250);
  };
  worker.onerror = (event) => parent.postMessage({ type: 'worker-error', message: String(event.message ?? 'worker load failed') }, '*');
  </script>`
  return `<iframe id="worker-proof" sandbox="allow-scripts"></iframe><script>
  globalThis.workerProof = null;
  globalThis.workerTerminated = false;
  globalThis.workerError = null;
  const frame = document.getElementById('worker-proof');
  addEventListener('message', (event) => {
    if (event.source !== frame.contentWindow) return;
    if (event.data.type === 'worker-proof') globalThis.workerProof = event.data.report;
    if (event.data.type === 'worker-terminated') globalThis.workerTerminated = true;
    if (event.data.type === 'worker-error') globalThis.workerError = event.data.message;
  });
  frame.srcdoc = ${JSON.stringify(child).replaceAll('<', '\\u003c')};
  </script>`
}
