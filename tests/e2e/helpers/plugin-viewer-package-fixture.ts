import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function writePluginViewerFixture(directory: string, conflict = false): Promise<void> {
  await mkdir(join(directory, 'dist'), { recursive: true })
  await writeFile(
    join(directory, 'orca-plugin.json'),
    JSON.stringify({
      manifestVersion: 2,
      execution: 'sandboxed-ui',
      pluginApi: 1,
      publisher: 'stablyai',
      id: 'orca-viewer-sample',
      name: 'Sample file viewer',
      version: '1.0.0',
      engines: { orca: '>=1.0.0' },
      description: 'Read-only support for an additional file format.',
      contributes: {
        fileViewers: [
          {
            id: 'sample',
            displayName: 'Sample file',
            entry: 'dist/sample.worker.js',
            selector: [{ filenamePattern: '*.viewer-fixture' }],
            rendering: 'host-ui',
            mode: 'readonly'
          },
          ...(conflict
            ? [
                {
                  id: 'alternate',
                  displayName: 'Alternate sample',
                  entry: 'dist/sample.worker.js',
                  selector: [{ filenamePattern: '*.viewer-fixture' }],
                  rendering: 'host-ui',
                  mode: 'readonly'
                }
              ]
            : []),
          ...(['table', 'canvas'] as const).map((kind) => ({
            id: kind,
            displayName: `Sample ${kind}`,
            entry: `dist/${kind}.worker.js`,
            selector: [{ filenamePattern: `*.${kind}-fixture` }],
            rendering: 'host-ui',
            mode: 'readonly'
          }))
        ]
      }
    })
  )
  await writeFile(
    join(directory, 'dist', 'sample.worker.js'),
    `let lines;
orcaViewer.register({
  async open(document) {
    const bytes = await orcaViewer.readBytes(0, Math.max(1, document.size));
    lines = new TextDecoder().decode(bytes).split('\\n');
    return {kind:'text',lineCount:lines.length};
  },
  render(viewport) {
    return {kind:'text',startLine:viewport.startLine,lines:lines.slice(viewport.startLine,viewport.startLine+viewport.lineCount)};
  }
});`
  )
  await writeFile(
    join(directory, 'dist', 'table.worker.js'),
    `let values;
orcaViewer.register({
  async open(document) {
    const bytes = await orcaViewer.readBytes(0, document.size);
    if (bytes[0] !== 42) throw new Error('unsupported_format');
    values = JSON.parse(new TextDecoder().decode(bytes.subarray(1)));
    return {kind:'table',sheets:[{id:'first',label:'First sheet',rowCount:200,columnCount:3},{id:'second',label:'Second sheet',rowCount:150,columnCount:2}]};
  },
  render(viewport) {
    const cells = [];
    const columns = viewport.sheetId === 'first' ? 3 : 2;
    const rows = viewport.sheetId === 'first' ? 200 : 150;
    for (let row=viewport.startRow;row<Math.min(rows,viewport.startRow+viewport.rowCount);row++) {
      for (let column=viewport.startColumn;column<Math.min(columns,viewport.startColumn+viewport.columnCount);column++) {
        cells.push({row,column,text: row === 0 && column === 0 ? values.title : viewport.sheetId + ':' + (row+1) + ':' + (column+1),kind:column === 1 ? 'cached-formula' : 'value'});
      }
    }
    return {kind:'table',sheetId:viewport.sheetId,cells};
  }
});`
  )
  await writeFile(
    join(directory, 'dist', 'canvas.worker.js'),
    `let color;
orcaViewer.register({
  async open(document) {
    const bytes = await orcaViewer.readBytes(0, document.size);
    if (bytes[0] !== 42) throw new Error('unsupported_format');
    color = JSON.parse(new TextDecoder().decode(bytes.subarray(1))).color;
    return {kind:'canvas',width:512,height:512};
  },
  render(viewport) {
    const pixels = new Uint8ClampedArray(viewport.width*viewport.height*4);
    const radius = Math.min(viewport.width,viewport.height)*0.3*viewport.camera.zoom;
    const shift = viewport.camera.yaw;
    for (let y=0;y<viewport.height;y++) for (let x=0;x<viewport.width;x++) {
      const offset = (y*viewport.width+x)*4;
      const inside = Math.hypot(x-viewport.width/2-shift,y-viewport.height/2-viewport.camera.pitch) < radius;
      pixels[offset]=inside ? color[0] : 0; pixels[offset+1]=inside ? color[1] : 0;
      pixels[offset+2]=inside ? color[2] : 0; pixels[offset+3]=inside ? 255 : 0;
    }
    return {kind:'canvas',width:viewport.width,height:viewport.height,pixels};
  }
});`
  )
}
