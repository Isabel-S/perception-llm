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

/** Copy data/single_call into dist at build time (excluding archive) so the public site can serve runs */
function copySingleCallDataToDist() {
  return {
    name: 'copy-single-call-data',
    closeBundle() {
      const outDir = path.join(process.cwd(), 'dist', 'data', 'single_call')
      if (!fs.existsSync(SINGLE_CALL_DIR)) {
        fs.mkdirSync(outDir, { recursive: true })
        fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({ runs: [] }))
        return
      }
      function copyRecursive(src, dest) {
        const entries = fs.readdirSync(src, { withFileTypes: true })
        for (const e of entries) {
          const srcPath = path.join(src, e.name)
          const destPath = path.join(dest, e.name)
          if (e.name === 'archive') continue
          if (e.isDirectory()) {
            fs.mkdirSync(destPath, { recursive: true })
            copyRecursive(srcPath, destPath)
          } else if (e.isFile() && e.name.endsWith('.json')) {
            fs.mkdirSync(path.dirname(destPath), { recursive: true })
            fs.copyFileSync(srcPath, destPath)
          }
        }
      }
      fs.mkdirSync(outDir, { recursive: true })
      copyRecursive(SINGLE_CALL_DIR, outDir)
      const manifest = buildSingleCallManifest()
      fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest))

      // Copy plot HTMLs from csvs_plots/plots/single_call to dist for Chart view
      const plotsSrc = path.join(process.cwd(), 'csvs_plots', 'plots', 'single_call')
      const plotsDest = path.join(process.cwd(), 'dist', 'data', 'plots', 'single_call')
      if (fs.existsSync(plotsSrc)) {
        fs.mkdirSync(plotsDest, { recursive: true })
        const files = fs.readdirSync(plotsSrc, { withFileTypes: true })
        for (const e of files) {
          if (e.isFile() && e.name.endsWith('.html')) {
            fs.copyFileSync(path.join(plotsSrc, e.name), path.join(plotsDest, e.name))
          }
        }
      }
    },
  }
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

        // Serve plot HTMLs from csvs_plots/plots in dev
        if (urlPath.startsWith('plots/')) {
          const plotPath = path.join(process.cwd(), 'csvs_plots', 'plots', urlPath.slice(6))
          if (plotPath.startsWith(path.join(process.cwd(), 'csvs_plots', 'plots'))) {
            fs.readFile(plotPath, (err, data) => {
              if (err) {
                res.statusCode = err.code === 'ENOENT' ? 404 : 500
                res.end(err.message)
                return
              }
              res.setHeader('Content-Type', 'text/html')
              res.end(data)
            })
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
  // GitHub Pages: set VITE_BASE_URL=/<repo-name>/ in the deploy workflow
  base: process.env.VITE_BASE_URL || '/',
  plugins: [react(), serveData(), copySingleCallDataToDist()],
})
