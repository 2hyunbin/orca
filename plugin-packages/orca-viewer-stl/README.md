# STL models

A standalone read-only binary STL viewer using the same `@orca/plugin-sdk/viewer` API as the spreadsheet package. No production dependencies, application imports, file paths, DOM, network or native conversion programs are required.

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
```

Release the prebuilt `dist/stl.worker.js` with `orca-plugin.json` and `LICENSE`. Orca executes only that worker after the user approves the exact package. The source, tests, lockfile and vendored public SDK archive make this directory ready to maintain as an independent `orca-viewer-stl` repository. The SDK archive includes source/license; replace it with an exact registry version when published.

Binary STL consists of an 80-byte header, little-endian triangle count and 50-byte triangle records. Exact file length is required; a header beginning “solid” is accepted when the binary structure matches. Finite geometry is normalized, projected, shaded and rasterized into an owned RGBA buffer. The host supplies orbit/zoom controls and displays the pixels. Transparent background follows the host's editor surface.

ASCII STL, per-facet color/material extensions, empty models and zero-size geometry are refused. Stored normals are checked for finite values; face shading uses geometric normals. This viewer does not edit, export, follow references or invoke other applications.

Limits: 50 MiB input, 100,000 triangles, 192 KiB reads, 10 seconds parsing, 1,024-pixel canvas dimensions, 8 million raster samples and 1.5 seconds per render. Parsing and rendering yield to preserve the host's independent liveness checks. Unsupported and over-budget files fail explicitly. Large highly overlapping meshes can reach the rendering budget even below the input limit.

The source corpus tests binary chunking, normalization, actual pixels, orbit/zoom, malformed length, unsupported records, finite/extreme coordinates, short reads and rendering quotas. A native macOS journey installs the prebuilt release through the catalog, explicitly approves it and displays a real binary model with orbit/zoom in a normal tab. Packaged-platform, remote and aggregate-memory checks remain release gates.

Format reference: [Library of Congress binary STL description](https://www.loc.gov/preservation/digital/formats/fdd/fdd000505.shtml).
