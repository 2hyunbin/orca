// Inside the distro: @parcel/watcher (orcad's watcher, inotify backend) on each root, plus raw fs.watch (inotify) on two
// /mnt/c leaf dirs to tell a parcel limitation from a kernel one. Prints events as JSON lines.
const watcher = require(process.env.PARCEL_WATCHER)
const fs = require('fs'), path = require('path')
;(async () => {
  const roots = process.argv.slice(2)
  for (const dir of ['pkgs/p03/c', 'pkgs/p04/d']) {
    const full = path.join(roots[0], dir)
    fs.watch(full, (type, name) => console.log(JSON.stringify({ at: Date.now(), src: 'fswatch', type, path: path.join(full, String(name)) })))
  }
  for (const root of roots) {
    const t = performance.now()
    await watcher.subscribe(root, (err, events) => {
      if (err) console.log(JSON.stringify({ error: String(err) }))
      for (const e of events) console.log(JSON.stringify({ at: Date.now(), src: 'parcel', type: e.type, path: e.path }))
    }, { ignore: ['.git', 'node_modules'] })
    console.log(JSON.stringify({ ready: root, subscribeMs: Math.round(performance.now() - t) }))
  }
  setTimeout(() => process.exit(0), +(process.env.WATCH_SECONDS || 90) * 1000)
})()
