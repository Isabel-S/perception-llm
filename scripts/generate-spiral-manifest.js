#!/usr/bin/env node
/**
 * Generates data/single_call/manifest.json from the directory structure.
 * Run from repo root: node scripts/generate-spiral-manifest.js
 * Skip folders named "archive".
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SINGLE_CALL = path.join(__dirname, '..', 'data', 'single_call')
const MANIFEST_PATH = path.join(SINGLE_CALL, 'manifest.json')

function buildManifest() {
  const runs = []
  if (!fs.existsSync(SINGLE_CALL)) {
    return { runs }
  }
  const mentalModels = fs.readdirSync(SINGLE_CALL, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name !== 'archive')

  for (const mm of mentalModels) {
    const mmPath = path.join(SINGLE_CALL, mm.name)
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

const manifest = buildManifest()
fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true })
fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8')
console.log('Wrote', MANIFEST_PATH, 'with', manifest.runs.length, 'runs')
