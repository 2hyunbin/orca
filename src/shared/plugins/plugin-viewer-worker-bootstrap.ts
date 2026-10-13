import { installPluginViewerWorkerSdk } from './plugin-viewer-worker-sdk'

export function createPluginViewerWorkerBootstrap(authorScriptUrl: string): string {
  if (!/^blob:null\/[a-f0-9-]+$/i.test(authorScriptUrl)) {
    throw new Error('viewer worker scripts require an opaque-origin blob')
  }
  // Import after lockdown: concatenating author code would let its hoisted globals run first.
  return `(() => {
  'use strict';
  const load = globalThis.importScripts.bind(globalThis);
  const define = Object.defineProperty;
  for (const key of ['Worker', 'SharedWorker', 'importScripts', 'fetch', 'WebSocket', 'WebTransport', 'RTCPeerConnection']) {
    define(globalThis, key, { value: undefined, writable: false, configurable: false });
  }
  (${installPluginViewerWorkerSdk.toString()})(globalThis);
  load(${JSON.stringify(authorScriptUrl)});
})();`
}
