#!/usr/bin/env node
/**
 * CLI for running eval flows from the terminal.
 * Usage:
 *   npm run run_eval -- --single_call --model_induct
 *   npm run run_eval -- --single_call --model_support_2
 *   npm run run_eval -- --separate_call --convo_1 --model_induct
 *   npm run run_eval -- --generate_convo
 *   npm run run_eval -- --human_data --model_induct --filename do_not_upload/h01.json
 *   npm run run_eval -- --backfill_empty --model_induct --file do_not_upload/h05-1/h05-1_induct_run_1.json
 *
 * Resume a single_call run (e.g. after content filter or crash):
 *   npm run run_eval -- --single_call --model_induct --resume_run run_gpt-4o_1 --api_gpt-4o --seed 21
 *   (Use the same --api_* and --seed as the original run.)
 *
 * API model (optional):
 *   --api_gemini     Use Google Gemini for completion
 *   --api_gpt-4o     Use Azure GPT-4o (default)
 *   --api_llama      Use Llama via Vertex AI (Node only; set GOOGLE_APPLICATION_CREDENTIALS, LLAMA_PROJECT_ID)
 *
 * Saves to data/:
 *   single_call: data/single_call/<model>/run_<api_model>_<#>/ (categories inside)
 *   separate_call: data/separate_call/convo_#/<model>/run_<api_model>_<#>/ (categories inside)
 *   generate_convo: data/separate_call/convo_#/ (categories inside)
 *   human_data: data/do_not_upload/<filename_no_ext>/<filename_no_ext>_<api_model>_<mental_model_type>.json
 *   backfill_empty: overwrites the given --file with mental models filled in for turns that had empty mentalModel.
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { SCENARIOS } from '../src/eval/scenarios.js'

try {
  const dotenv = (await import('dotenv')).default
  dotenv.config()
} catch (_) {}

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_ROOT = join(__dirname, '..', 'data')

function parseArgs() {
  const args = process.argv.slice(2)
  const flags = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--single_call') flags.single_call = true
    else if (args[i] === '--separate_call') flags.separate_call = true
    else if (args[i] === '--generate_convo') flags.generate_convo = true
    else if (args[i] === '--human_data') flags.human_data = true
    else if (args[i] === '--model_induct') flags.model = 'induct'
    else if (args[i] === '--model_support_2') flags.model = 'types_support'
    else if (args[i] === '--prior') flags.use_prior = true
    else if (args[i] === '--convo_1') flags.convo = 'convo_1'
    else if (args[i] === '--convo_2') flags.convo = 'convo_2'
    else if (args[i] === '--convo_3') flags.convo = 'convo_3'
    else if (args[i] === '--filename' && args[i + 1]) { flags.filename = args[i + 1]; i++ }
    else if (args[i] === '--backfill_empty') flags.backfill_empty = true
    else if (args[i] === '--file' && args[i + 1]) { flags.file = args[i + 1]; i++ }
    else if (args[i] === '--api_gemini') flags.api_provider = 'gemini'
    else if (args[i] === '--api_gpt-4o' || args[i] === '--api_gpt4o') flags.api_provider = 'gpt-4o'
    else if (args[i] === '--api_llama') flags.api_provider = 'llama'
    else if (args[i] === '--resume_run' && args[i + 1]) { flags.resume_run = args[i + 1]; i++ }
    else if (args[i] === '--seed' && args[i + 1]) {
      const n = parseInt(args[i + 1], 10)
      if (!Number.isNaN(n)) flags.seed = n
      i++
    }
    else if (args[i].startsWith('--convo_')) flags.convo = args[i].slice(1)
  }
  return flags
}

function getNextRunNumber(baseDir) {
  if (!existsSync(baseDir)) return 1
  const entries = readdirSync(baseDir, { withFileTypes: true })
  let max = 0
  for (const e of entries) {
    if (e.isDirectory()) {
      const m = e.name.match(/^run_(\d+)$/)
      if (m) max = Math.max(max, parseInt(m[1], 10))
    }
  }
  return max + 1
}

/** Next run number for run_<apiModel>_<n> folders (e.g. run_gemini_1, run_gpt-4o_2). */
function getNextRunNumberForApi(baseDir, apiModel) {
  if (!existsSync(baseDir)) return 1
  const api = (apiModel || 'gpt-4o')
  const prefix = `run_${api}_`
  const entries = readdirSync(baseDir, { withFileTypes: true })
  let max = 0
  for (const e of entries) {
    if (e.isDirectory() && e.name.startsWith(prefix)) {
      const n = parseInt(e.name.slice(prefix.length), 10)
      if (!Number.isNaN(n)) max = Math.max(max, n)
    }
  }
  return max + 1
}

/** Load existing single_call run from disk and compute startScenarioIndex for resume. */
function loadExistingRunFromDisk(basePath, runId, numTurns = 20) {
  const runDir = join(basePath, runId)
  if (!existsSync(runDir)) return null
  const scenarios = {}
  for (const s of SCENARIOS) {
    const key = `${s.category}/${s.prompt_id}`
    const filePath = join(runDir, s.category, `${s.prompt_id}.json`)
    if (!existsSync(filePath)) continue
    try {
      const data = JSON.parse(readFileSync(filePath, 'utf8'))
      const turns = data.turns || []
      scenarios[key] = { turns, metadata: data.metadata || { category: s.category, prompt_id: s.prompt_id } }
    } catch (_) {}
  }
  let startScenarioIndex = 0
  for (let i = 0; i < SCENARIOS.length; i++) {
    const s = SCENARIOS[i]
    const key = `${s.category}/${s.prompt_id}`
    const existing = scenarios[key]
    if (!existing || !Array.isArray(existing.turns) || existing.turns.length < numTurns) {
      startScenarioIndex = i
      break
    }
    if (i === SCENARIOS.length - 1) startScenarioIndex = SCENARIOS.length
  }
  return { scenarios, startScenarioIndex }
}

function getNextConvoNumber() {
  const base = join(DATA_ROOT, 'separate_call')
  if (!existsSync(base)) return 1
  const entries = readdirSync(base, { withFileTypes: true })
  let max = 0
  for (const e of entries) {
    if (e.isDirectory()) {
      const m = e.name.match(/^convo_(\d+)$/)
      if (m) max = Math.max(max, parseInt(m[1], 10))
    }
  }
  return max + 1
}

function scenarioPayloadForZip(turns, metadata = {}) {
  const lastTurn = turns.length ? turns[turns.length - 1] : null
  const situation_log = lastTurn?.mentalModel?.memory?.situation_log ?? null
  const turnsForZip = turns.map((t) => {
    const mm = t.mentalModel
    if (!mm?.memory) return t
    const { situation_log: _sl, ...restMemory } = mm.memory
    return { ...t, mentalModel: { ...mm, memory: restMemory } }
  })
  return { ...metadata, turns: turnsForZip, situation_log }
}

function writeScenariosToRunFolder(basePath, runId, scenarios) {
  const runDir = join(basePath, runId)
  mkdirSync(runDir, { recursive: true })
  for (const [key, data] of Object.entries(scenarios)) {
    const [category, promptId] = key.split('/')
    const catDir = join(runDir, category)
    mkdirSync(catDir, { recursive: true })
    const turns = Array.isArray(data) ? data : data.turns
    const metadata = Array.isArray(data) ? { category, prompt_id: promptId } : data.metadata
    const payload = scenarioPayloadForZip(turns, metadata)
    writeFileSync(join(catDir, `${promptId}.json`), JSON.stringify(payload, null, 2))
  }
  return runDir
}

function writeConvoScenariosToFolder(basePath, scenarios) {
  mkdirSync(basePath, { recursive: true })
  for (const [key, data] of Object.entries(scenarios)) {
    const [category, promptId] = key.split('/')
    const catDir = join(basePath, category)
    mkdirSync(catDir, { recursive: true })
    const { turns, metadata } = Array.isArray(data) ? { turns: data, metadata: { category, prompt_id: key.split('/')[1] } } : data
    const payload = { ...metadata, turns }
    writeFileSync(join(catDir, `${promptId}.json`), JSON.stringify(payload, null, 2))
  }
  return basePath
}

function log(msg) {
  const ts = new Date().toISOString()
  console.log(`[${ts}] ${msg}`)
}

async function main() {
  const flags = parseArgs()

  const single = flags.single_call && (flags.model === 'induct' || flags.model === 'types_support')
  const separate = flags.separate_call && flags.convo && (flags.model === 'induct' || flags.model === 'types_support')
  const generate = flags.generate_convo
  const human = flags.human_data && (flags.model === 'induct' || flags.model === 'types_support') && flags.filename
  const backfill = flags.backfill_empty && (flags.model === 'induct' || flags.model === 'types_support') && flags.file

  const modeCount = [single, separate, generate, human, backfill].filter(Boolean).length
  if (modeCount !== 1) {
    console.error('Usage: specify exactly one mode and required options.')
    console.error('  --single_call --model_induct | --model_support_2')
    console.error('  --separate_call --convo_1 (or convo_2, ...) --model_induct | --model_support_2')
    console.error('  --generate_convo')
    console.error('  --human_data --model_induct | --model_support_2 --filename <path>')
    console.error('  --backfill_empty --model_induct | --model_support_2 --file <path>')
    console.error('Optional: --prior (include prior mental model scores in prompt and mark runs/JSON with prior=true for induct/types_support)')
    console.error('Optional: --resume_run <runId> (single_call only: resume from existing run folder, e.g. run_gpt-4o_1)')
    console.error('Optional: --api_gemini | --api_gpt-4o | --api_llama (default: gpt-4o)')
    console.error('Optional (sim/generate only): --seed <int> to fix RNG seed')
    process.exit(1)
  }

  const api = await import('../src/services/api.js')
  if (flags.api_provider) api.setApiProvider(flags.api_provider)

  if (single) {
    const model = flags.model
    const apiProvider = api.getApiProvider()
    const basePath = join(DATA_ROOT, 'single_call', model)
    const numTurns = 20
    let runId
    let existingRun = null
    let startScenarioIndex = 0
    if (flags.resume_run) {
      runId = flags.resume_run
      const loaded = loadExistingRunFromDisk(basePath, runId, numTurns)
      if (!loaded) {
        console.error(`Resume failed: run not found at ${join(basePath, runId)}`)
        process.exit(1)
      }
      existingRun = { scenarios: loaded.scenarios }
      startScenarioIndex = loaded.startScenarioIndex
      if (startScenarioIndex >= SCENARIOS.length) {
        log(`Run ${runId} already complete (${SCENARIOS.length} scenarios). Nothing to do.`)
        return
      }
      log(`Resuming run ${runId} from scenario ${startScenarioIndex + 1}/30 (${SCENARIOS[startScenarioIndex]?.category}/${SCENARIOS[startScenarioIndex]?.prompt_id})`)
    } else {
      const runNum = getNextRunNumberForApi(basePath, apiProvider)
      const priorSuffix = flags.use_prior ? '_prior' : ''
      runId = `run_${apiProvider}_${runNum}${priorSuffix}`
    }
    log(`Single call, model=${model}, api=${apiProvider}, runId=${runId}, 30 scenarios × ${numTurns} turns${flags.seed != null ? `, seed=${flags.seed}` : ''}${flags.use_prior ? ', prior=on' : ''}${existingRun ? ', resuming' : ''}`)
    const result = await api.run_simulations({
      mentalModelType: model,
      useSeparateMentalModelResponse: false,
      usePrior: !!flags.use_prior,
      numTurns,
      runId,
      seed: flags.seed,
      startScenarioIndex,
      existingRun,
      downloadWhenDone: false,
      saveAfterEachConvo: false,
      onScenarioStart: (runId, cat, pid) => log(`Scenario ${cat}/${pid}`),
      onTurn: (runId, cat, pid, t, u, a, mm) => log(`  turn ${t + 1}/${numTurns}`),
      onProgress: (runId, cat, pid, t, total, globalNum) => log(`  Convo ${globalNum}/30 ${cat}/${pid} turn ${t + 1}/${total}`),
      onAfterScenario: (runId, scenarios) => {
        writeScenariosToRunFolder(basePath, runId, scenarios)
        log(`  Saved ${Object.keys(scenarios).length} scenario(s) to ${basePath}/${runId}`)
      },
    })
    log(`Done. ${Object.keys(result.scenarios).length} scenarios in ${basePath}/${runId}`)
    return
  }

  if (separate) {
    const model = flags.model
    const apiProvider = api.getApiProvider()
    const convoFolder = flags.convo
    const convoPath = join(DATA_ROOT, 'separate_call', convoFolder)
    if (!existsSync(convoPath)) {
      console.error(`Convo folder not found: ${convoPath}`)
      process.exit(1)
    }
    const basePath = join(DATA_ROOT, 'separate_call', convoFolder, model)
    const runNum = getNextRunNumberForApi(basePath, apiProvider)
    const priorSuffix = flags.use_prior ? '_prior' : ''
    const runId = `run_${apiProvider}_${runNum}${priorSuffix}`
    log(`Separate call, convo=${convoFolder}, model=${model}, api=${apiProvider}, runId=${runId}${flags.seed != null ? `, seed=${flags.seed}` : ''}${flags.use_prior ? ', prior=on' : ''}`)
    const getConvo = (category, promptId) => {
      const p = join(convoPath, category, `${promptId}.json`)
      try {
        const raw = readFileSync(p, 'utf8')
        return Promise.resolve(JSON.parse(raw))
      } catch (e) {
        return Promise.resolve(null)
      }
    }
    const result = await api.run_simulations({
      mentalModelType: model,
      useSeparateMentalModelResponse: true,
      usePrior: !!flags.use_prior,
      numTurns: 20,
      runId,
      seed: flags.seed,
      getConvo,
      downloadWhenDone: false,
      saveAfterEachConvo: false,
      onScenarioStart: (runId, cat, pid) => log(`Scenario ${cat}/${pid}`),
      onTurn: (runId, cat, pid, t, u, a, mm) => log(`  turn ${t + 1}`),
      onProgress: (runId, cat, pid, t, total, globalNum) => log(`  Convo ${globalNum}/30 ${cat}/${pid} turn ${t + 1}/${total}`),
      onAfterScenario: (runId, scenarios) => {
        writeScenariosToRunFolder(basePath, runId, scenarios)
        log(`  Saved ${Object.keys(scenarios).length} scenario(s) to ${basePath}/${runId}`)
      },
    })
    log(`Done. ${Object.keys(result.scenarios).length} scenarios in ${basePath}/${runId}`)
    return
  }

  if (generate) {
    const convoNum = getNextConvoNumber()
    const convoFolder = `convo_${convoNum}`
    const basePath = join(DATA_ROOT, 'separate_call', convoFolder)
    log(`Generate convos: ${convoFolder}, 30 × 20 turns${flags.seed != null ? `, seed=${flags.seed}` : ''}`)
    const result = await api.runGenerateConvos({
      numTurns: 20,
      seed: flags.seed,
      onScenarioStart: (cat, pid) => log(`Scenario ${cat}/${pid}`),
      onProgress: (cat, pid, t, total, globalNum) => log(`  Convo ${globalNum}/30 ${cat}/${pid} turn ${t + 1}/${total}`),
    })
    const written = writeConvoScenariosToFolder(basePath, result.scenarios)
    log(`Done. Wrote ${convoFolder} to ${written}`)
    return
  }

  if (human) {
    const model = flags.model
    const apiProvider = api.getApiProvider()
    const dataPath = flags.filename
    const pathParts = dataPath.replace(/\.json$/i, '').split('/')
    const filenameNoExt = pathParts[pathParts.length - 1]
    const humanDir = join(DATA_ROOT, 'do_not_upload', filenameNoExt)
    const priorSuffix = flags.use_prior ? '_prior' : ''
    const outputFileName = `${filenameNoExt}_${apiProvider}_${model}${priorSuffix}.json`
    const outputPath = join(humanDir, outputFileName)

    let existingResult = null
    if (existsSync(outputPath)) {
      try {
        const checkpoint = JSON.parse(readFileSync(outputPath, 'utf8'))
        if (checkpoint?.meta && Array.isArray(checkpoint?.turns)) {
          existingResult = { meta: checkpoint.meta, turns: checkpoint.turns }
          const upTo = checkpoint.meta?.turns_recorded_up_to ?? -1
          log(`Resuming from checkpoint: ${outputPath} (recorded up to turn ${upTo + 1})`)
        }
      } catch (e) {
        log(`Could not load checkpoint ${outputPath}: ${e.message}. Starting fresh.`)
      }
    }
    const runId = `${filenameNoExt}_${apiProvider}_${model}${priorSuffix}`
    const inputPath = join(DATA_ROOT, dataPath)
    if (!existsSync(inputPath)) {
      console.error(`File not found: ${inputPath}`)
      process.exit(1)
    }
    const rawData = JSON.parse(readFileSync(inputPath, 'utf8'))
    if (!rawData?.messages?.length) {
      console.error('JSON must have a messages array')
      process.exit(1)
    }
    if (!existingResult) log(`Human data: ${dataPath}, model=${model}, api=${apiProvider}, output=${outputFileName} (new run)`)
    else log(`Human data: ${dataPath}, model=${model}, api=${apiProvider}, output=${outputFileName}`)
    mkdirSync(humanDir, { recursive: true })
    const result = await api.runHumanDataAnalysis({
      dataPath,
      mentalModelType: model,
      usePrior: !!flags.use_prior,
      rawData,
      runId,
      existingResult,
      downloadWhenDone: false,
      onSaveCheckpoint: (res) => {
        writeFileSync(outputPath, JSON.stringify({ meta: res.meta, turns: res.turns }, null, 2))
        log(`  Saved checkpoint up to turn ${res.meta.turns_recorded_up_to + 1}`)
      },
      onProgress: (runId, sourceId, t, total) => log(`  turn ${t + 1}/${total}`),
    })
    writeFileSync(outputPath, JSON.stringify({ meta: result.meta, turns: result.turns }, null, 2))
    log(`Done. Wrote ${outputPath}`)
    return
  }

  if (backfill) {
    const model = flags.model
    const filePath = join(DATA_ROOT, flags.file)
    if (!existsSync(filePath)) {
      console.error(`File not found: ${filePath}`)
      process.exit(1)
    }
    log(`Backfill empty mental models: ${filePath}, model=${model}`)
    const data = JSON.parse(readFileSync(filePath, 'utf8'))
    if (!data?.turns?.length) {
      console.error('JSON must have a turns array')
      process.exit(1)
    }
    const emptyCount = data.turns.filter((t) => api.isEmptyMentalModel(t.mentalModel, model)).length
    log(`Found ${emptyCount} turn(s) with empty mental model to backfill`)
    if (emptyCount === 0) {
      log('Nothing to do.')
      return
    }
    await api.backfillEmptyMentalModelsForHumanResult({
      result: data,
      mentalModelType: model,
      onProgress: (turnIndex, total, emptyTotal) => log(`  Backfilled turn ${turnIndex + 1}/${total} (${emptyTotal} empty)`),
      onTurn: (turnIndex, u, a, mm) => log(`  Turn ${turnIndex + 1} filled`)
    })
    writeFileSync(filePath, JSON.stringify({ meta: data.meta, turns: data.turns }, null, 2))
    log(`Done. Wrote ${filePath}`)
    return
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
