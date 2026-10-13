# Orca plugin SDK

This standalone package defines the version 1 read-only file-viewer contract. Orca's own validators and worker bridge use these same types. No app source, Node API, renderer API, installation hook or network client is included.

```ts
import type { PluginViewerWorkerSdk } from '@orca/plugin-sdk/viewer'
declare const orcaViewer: PluginViewerWorkerSdk
```

Implement `open(document)` and `render(viewport)` and register the adapter once. Read the already-opened document through `readBytes(position, length)` in chunks no larger than 192 KiB. The SDK supplies no paths or write operation. Orca renders returned text, table cells or RGBA canvas pixels and validates every response.

Prebundle dependencies into one worker script. Do not create workers, fetch URLs, open sockets or import scripts at runtime. Orca terminates parsing after 10 seconds, a render after 2 seconds, and an unresponsive worker independently of its event loop. Throw an Error with `code: 'unsupported_format'` or `code: 'limit_exceeded'` for those recoverable failures; other errors become `parse_failed` without exposing exception details.

Run `npm ci`, `npm run build`, then `npm pack` to create the SDK archive. Source types ship in the archive, so independent packages can typecheck without a checkout of Orca. This directory can become the `orca-plugin-sdk` repository. Publishing the npm package or creating its repository is a separate release action; nothing here publishes automatically.
