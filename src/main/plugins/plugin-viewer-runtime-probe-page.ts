import type { PluginViewerDocumentInfo } from '../../shared/plugins/plugin-viewer-document'
import type { PluginViewerWorkerBinding } from '../../shared/plugins/plugin-viewer-worker-protocol'

export function pluginViewerRuntimeProbePage(
  script: string,
  document: PluginViewerDocumentInfo,
  binding: PluginViewerWorkerBinding
): string {
  const child = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:; connect-src 'none'; object-src 'none'; frame-src 'none'">
  <script>${script.replaceAll(/<\/script/gi, '<\\/script')}</script>`
  return `<iframe id="runtime-proof" sandbox="allow-scripts"></iframe><script>
  globalThis.runtimeProof = null;
  const frame = document.getElementById('runtime-proof');
  addEventListener('message', (event) => {
    if (event.source !== frame.contentWindow) return;
    const message = event.data;
    if (message.type === 'runtime-read') {
      viewerProbe.read(message.request).then((response) => {
        frame.contentWindow.postMessage({type:'runtime-read-result',id:message.id,response}, '*');
      }).catch(() => {
        frame.contentWindow.postMessage({type:'runtime-read-result',id:message.id,response:{ok:false,error:'read_failed'}}, '*');
      });
    }
    if (message.type === 'runtime-proof') globalThis.runtimeProof = message.proof;
  });
  frame.addEventListener('load', () => frame.contentWindow.postMessage({type:'runtime-start',document:${JSON.stringify(document)},binding:${JSON.stringify(binding)}}, '*'), {once:true});
  frame.srcdoc = ${JSON.stringify(child).replaceAll('<', '\\u003c')};
  </script>`
}
