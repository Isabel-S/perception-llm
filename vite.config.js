import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import fs from 'fs'

/** Serve ./data at /data so the app can fetch conversation JSONs */
function serveData() {
  return {
    name: 'serve-data',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/data/')) return next()
        const filePath = path.join(process.cwd(), 'data', req.url.slice(6).replace(/\?.*$/, ''))
        if (!filePath.startsWith(path.join(process.cwd(), 'data'))) return next()
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
