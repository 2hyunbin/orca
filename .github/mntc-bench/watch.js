// Inside the distro: @parcel/watcher (orcad's watcher, inotify backend) on each root; prints events as JSON lines.
const watcher = require(process.env.PARCEL_WATCHER)
;(async () => {
  for (const root of process.argv.slice(2)) {
    const t = performance.now()
    await watcher.subscribe(root, (err, events) => {
      if (err) console.log(JSON.stringify({ error: String(err) }))
      for (const e of events) console.log(JSON.stringify({ at: Date.now(), type: e.type, path: e.path }))
    }, { ignore: ['.git', 'node_modules'] })
    console.log(JSON.stringify({ ready: root, subscribeMs: Math.round(performance.now() - t) }))
  }
  setTimeout(() => process.exit(0), +(process.env.WATCH_SECONDS || 90) * 1000)
})()
