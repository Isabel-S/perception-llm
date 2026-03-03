import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import fs from 'fs'

const SINGLE_CALL_DIR = path.join(process.cwd(), 'data', 'single_call')

function buildSingleCallManifest() {
  const runs = []
  if (!fs.existsSync(SINGLE_CALL_DIR)) return { runs }
  const mentalModels = fs.readdirSync(SINGLE_CALL_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name !== 'archive')
  for (const mm of mentalModels) {
    const mmPath = path.join(SINGLE_CALL_DIR, mm.name)
    const runDirs = fs.readdirSync(mmPath, { withFileTypes: true })
      .filter(d => d.isDirectory())
    for (const runDir of runDirs) {
      const runPath = path.join(mmPath, runDir.name)
      const categories = {}
      const catDirs = fs.readdirSync(runPath, { withFileTypes: true })
        .filter(d => d.isDirectory())
      for (const cat of catDirs) {
        const catPath = path.join(runPath, cat.name)
        const files = fs.readdirSync(catPath, { withFileTypes: true })
          .filter(f => f.isFile() && f.name.endsWith('.json'))
        const promptIds = files.map(f => f.name.replace(/\.json$/, '')).sort()
        if (promptIds.length) categories[cat.name] = promptIds
      }
      if (Object.keys(categories).length > 0) {
        runs.push({
          id: `${mm.name}/${runDir.name}`,
          mentalModel: mm.name,
          runFolder: runDir.name,
          label: `${mm.name} — ${runDir.name}`,
          categories,
        })
      }
    }
  }
  runs.sort((a, b) => a.id.localeCompare(b.id))
  return { runs }
}

/** Serve ./data at /data so the app can fetch conversation JSONs */
function serveData() {
  return {
    name: 'serve-data',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/data/')) return next()
        const urlPath = req.url.slice(6).replace(/\?.*$/, '')
        const filePath = path.join(process.cwd(), 'data', urlPath)
        if (!filePath.startsWith(path.join(process.cwd(), 'data'))) return next()

        if (urlPath === 'single_call/manifest.json') {
          try {
            let manifest
            if (fs.existsSync(filePath)) {
              manifest = JSON.parse(fs.readFileSync(filePath, 'utf8'))
            } else {
              manifest = buildSingleCallManifest()
            }
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(manifest))
            return
          } catch (e) {
            res.statusCode = 500
            res.end(e.message)
            return
          }
        }

        fs.readFile(filePath, (err, data) => {
          if (err) {
            res.statusCode = err.code === 'ENOENT' ? 404 : 500
            res.end(err.message)
            return
          }
          res.setHeader('Content-Type', 'application/json')
          res.end(data)
        })
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), serveData()],
})
