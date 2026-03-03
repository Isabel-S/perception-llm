// API service for Azure OpenAI and Google Gemini
// Azure: VITE_AZURE_* env vars
// Gemini (browser): VITE_GEMINI_API_KEY (Google AI Studio key)
// Gemini (Node/CLI): Vertex AI with service account JSON.
//   Set GOOGLE_APPLICATION_CREDENTIALS=path/to/service_account.json in .env
//   Optional: VITE_GEMINI_PROJECT_ID, VITE_GEMINI_LOCATION (default us-central1), VITE_GEMINI_MODEL
// Llama (Node/CLI only): Vertex AI with same service account.
//   Set GOOGLE_APPLICATION_CREDENTIALS, LLAMA_PROJECT_ID (or VITE_LLAMA_*), optional LLAMA_LOCATION, LLAMA_MODEL_ID
// Provider: VITE_API_PROVIDER=gpt-4o|gemini|llama (or set via UI/CLI)

import JSZip from 'jszip'
import { DEFAULT_SEEKER_PROMPT } from '../eval/default_prompt.js'
import { CATEGORY_INJECTIONS } from '../eval/categories.js'
import { INJECTION_BEHAVIORS } from '../eval/injections.js'
import { SCENARIOS } from '../eval/scenarios.js'
import {
  buildPromptWithHistory,
  buildMentalModelOnlyPrompt,
  buildResponseOnlyPrompt,
  buildHistoryBlockWithPriors,
  parseSingleCallResponse,
  parseMentalModelOnlyResponse,
  parseResponseOnlyContent,
  INLINE_MENTAL_MODEL_TYPES
} from '../eval/mental_model_prompts.js'

const env = typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env : (typeof process !== 'undefined' ? process.env : {})
const AZURE_ENDPOINT = env.VITE_AZURE_ENDPOINT ?? ''
const AZURE_API_KEY = env.VITE_AZURE_API_KEY ?? ''
const AZURE_DEPLOYMENT = env.VITE_AZURE_DEPLOYMENT ?? ''
const AZURE_API_VERSION = env.VITE_AZURE_API_VERSION ?? ''

const DEFAULT_AZURE_DEPLOYMENT = 'gpt-4o'
const DEFAULT_AZURE_API_VERSION = '2024-12-01-preview'

/** User-provided Azure config (e.g. from UI). Only endpoint and apiKey; deployment/version use defaults. */
let userAzureConfig = { endpoint: '', apiKey: '' }

export function setAzureConfig(config) {
  if (!config) {
    userAzureConfig = { endpoint: '', apiKey: '' }
    return
  }
  userAzureConfig = {
    endpoint: (config.endpoint ?? userAzureConfig.endpoint ?? '').trim(),
    apiKey: (config.apiKey ?? userAzureConfig.apiKey ?? '').trim(),
  }
}

export function getAzureConfig() {
  return { ...userAzureConfig }
}

function getEffectiveAzureConfig() {
  const u = userAzureConfig
  const hasUser = u.endpoint && u.apiKey
  if (hasUser) {
    const endpoint = u.endpoint.endsWith('/') ? u.endpoint : u.endpoint + '/'
    return {
      endpoint,
      apiKey: u.apiKey,
      deployment: DEFAULT_AZURE_DEPLOYMENT,
      apiVersion: DEFAULT_AZURE_API_VERSION,
    }
  }
  const endpoint = (AZURE_ENDPOINT || '').endsWith('/') ? AZURE_ENDPOINT : (AZURE_ENDPOINT || '') + '/'
  return {
    endpoint,
    apiKey: AZURE_API_KEY || '',
    deployment: AZURE_DEPLOYMENT || DEFAULT_AZURE_DEPLOYMENT,
    apiVersion: AZURE_API_VERSION || DEFAULT_AZURE_API_VERSION,
  }
}

const GEMINI_API_KEY = env.VITE_GEMINI_API_KEY ?? ''
const GEMINI_MODEL = env.VITE_GEMINI_MODEL || 'gemini-1.5-flash'
const GEMINI_PROJECT_ID = env.VITE_GEMINI_PROJECT_ID || env.GEMINI_PROJECT_ID || ''
const GEMINI_LOCATION = env.VITE_GEMINI_LOCATION || env.GEMINI_LOCATION || 'us-central1'
/** In Node, path to service account JSON for Vertex AI (optional; when set, Gemini uses Vertex instead of API key). */
const GOOGLE_APPLICATION_CREDENTIALS = typeof process !== 'undefined' && process.env && process.env.GOOGLE_APPLICATION_CREDENTIALS
/** Llama via Vertex AI (Node only). Same service account as Gemini Vertex. */
const LLAMA_PROJECT_ID = env.VITE_LLAMA_PROJECT_ID || env.LLAMA_PROJECT_ID || ''
const LLAMA_LOCATION = env.VITE_LLAMA_LOCATION || env.LLAMA_LOCATION || 'us-central1'
const LLAMA_MODEL_ID = env.VITE_LLAMA_MODEL_ID || env.LLAMA_MODEL_ID || 'meta/llama-3.3-70b-instruct-maas'
const DEFAULT_API_PROVIDER = (() => {
  const p = (env.VITE_API_PROVIDER || 'gpt-4o').toLowerCase().replace(/-/g, '')
  if (p === 'gemini') return 'gemini'
  if (p === 'llama') return 'llama'
  return 'gpt-4o'
})()

/** Current API provider: 'gpt-4o' | 'gemini' | 'llama'. Set via setApiProvider (UI/CLI). */
let apiProvider = DEFAULT_API_PROVIDER

export function setApiProvider(provider) {
  const p = String(provider || '').toLowerCase().replace(/-/g, '')
  if (p === 'gemini') apiProvider = 'gemini'
  else if (p === 'llama') apiProvider = 'llama'
  else apiProvider = 'gpt-4o'
}

export function getApiProvider() {
  return apiProvider
}

function requireAzureEnv() {
  const c = getEffectiveAzureConfig()
  if (!c.endpoint || !c.apiKey) {
    throw new Error(
      'Azure OpenAI config missing. Enter your Azure endpoint and API key in the "Azure credentials" section below (or set VITE_AZURE_ENDPOINT and VITE_AZURE_API_KEY in .env for local dev).'
    )
  }
}

function requireGeminiEnv() {
  const isNode = typeof process !== 'undefined' && process.versions?.node
  const hasVertexFile = isNode && GOOGLE_APPLICATION_CREDENTIALS
  if (hasVertexFile) return
  if (!GEMINI_API_KEY) {
    const hint = isNode
      ? 'Set GOOGLE_APPLICATION_CREDENTIALS (path to service_account.json) in .env for Vertex AI. In the browser, set VITE_GEMINI_API_KEY (Google AI Studio).'
      : 'In the browser, set VITE_GEMINI_API_KEY in .env (get a key from https://aistudio.google.com/apikey). For service account (Vertex), run evals from the CLI with --api_gemini.'
    throw new Error(`Gemini config missing. ${hint}`)
  }
}

/** Llama via Vertex AI: Node only, requires GOOGLE_APPLICATION_CREDENTIALS and LLAMA_PROJECT_ID (or VITE_LLAMA_*). */
function requireLlamaEnv() {
  const isNode = typeof process !== 'undefined' && process.versions?.node
  if (!isNode) {
    throw new Error('Llama provider is only available in Node (CLI). Set GOOGLE_APPLICATION_CREDENTIALS and LLAMA_PROJECT_ID, then run evals with --api_llama.')
  }
  if (!GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error('Llama Vertex: set GOOGLE_APPLICATION_CREDENTIALS=path/to/service_account.json in .env')
  }
  if (!LLAMA_PROJECT_ID) {
    throw new Error('Llama Vertex: set LLAMA_PROJECT_ID or VITE_LLAMA_PROJECT_ID in .env')
  }
}

/** Require env for the currently selected provider. */
function requireCurrentProviderEnv() {
  if (apiProvider === 'gemini') requireGeminiEnv()
  else if (apiProvider === 'llama') requireLlamaEnv()
  else requireAzureEnv()
}

// Generation defaults
const DEFAULT_MAX_COMPLETION_TOKENS = 5000
const DEFAULT_TEMPERATURE = 0.7
const DEFAULT_TOP_P = 0.9

const RATE_LIMIT_MAX_RETRIES = 10
const DELAY_BETWEEN_CALLS_MS = 800

// Allow much longer timeouts for large prompts when running via Node/CLI (human data, evals).
const IS_NODE_ENV = typeof process !== 'undefined' && process.versions?.node
const REQUEST_TIMEOUT_MS = IS_NODE_ENV ? 600000 : 120000

/** Minimum wait (seconds) when API says "retry after X" — use at least this so we don't retry too soon. */
const RATE_LIMIT_MIN_WAIT_SEC = 30
/** Default wait (seconds) when rate limited but no "retry after" in message. */
const RATE_LIMIT_DEFAULT_WAIT_SEC = 35

function isRateLimitError(err) {
  const msg = (err?.message || '').toLowerCase()
  return msg.includes('rate limit') || msg.includes('token rate limit') || msg.includes('exceeded') || msg.includes('429')
}

function isTimeoutError(err) {
  const msg = (err?.message || '').toLowerCase()
  return err?.name === 'AbortError' || msg.includes('timeout') || msg.includes('408') || msg.includes('504') || msg.includes('abort')
}

/** e.g. ERR_SOCKET_NOT_CONNECTED, Failed to fetch, network/connection dropped */
function isNetworkError(err) {
  const msg = (err?.message || '').toLowerCase()
  return msg.includes('failed to fetch') || msg.includes('network') || msg.includes('socket') || msg.includes('connection')
}

/** Azure content filter / content management policy — prompt or response was blocked. */
function isContentFilterError(err) {
  const msg = (err?.message || '').toLowerCase()
  return msg.includes('content management policy') || msg.includes('content filter') || msg.includes('filtered due to')
}

function parseRetryAfterSeconds(err) {
  const match = (err?.message || '').match(/retry after (\d+) seconds/i)
  return match ? Math.max(parseInt(match[1], 10), RATE_LIMIT_MIN_WAIT_SEC) : null
}

/** Wait DELAY_BETWEEN_CALLS_MS, run fn(); on rate limit, timeout, or network error, wait and retry up to RATE_LIMIT_MAX_RETRIES times. */
async function withRetryOnRateLimit(fn) {
  let lastErr
  for (let attempt = 0; attempt <= RATE_LIMIT_MAX_RETRIES; attempt++) {
    try {
      await new Promise(r => setTimeout(r, DELAY_BETWEEN_CALLS_MS))
      return await fn()
    } catch (err) {
      lastErr = err
      const retryable = isRateLimitError(err) || isTimeoutError(err) || isNetworkError(err)
      if (attempt < RATE_LIMIT_MAX_RETRIES && retryable) {
        const rawSec = isRateLimitError(err) ? (parseRetryAfterSeconds(err) ?? RATE_LIMIT_DEFAULT_WAIT_SEC) : 15
        const sec = isRateLimitError(err) ? Math.max(rawSec, RATE_LIMIT_MIN_WAIT_SEC) : rawSec
        const waitMs = sec * 1000
        const reason = isTimeoutError(err) ? 'Request timeout' : isNetworkError(err) ? 'Network/socket error' : 'Rate limited'
        console.warn(`${reason}. Waiting ${sec}s before retry (${attempt + 1}/${RATE_LIMIT_MAX_RETRIES})...`)
        await new Promise(r => setTimeout(r, waitMs))
        continue
      }
      throw err
    }
  }
  throw lastErr
}

/** fetch with client-side timeout so we don't hang indefinitely. */
function fetchWithTimeout(url, options, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), timeoutMs)
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(id))
}

/** Strip markdown code fences from JSON string if present */
function stripJsonFences(text) {
  let s = text.trim()
  if (s.startsWith('```json')) s = s.replace(/^```json\s*/, '').replace(/\s*```$/, '')
  else if (s.startsWith('```')) s = s.replace(/^```\s*/, '').replace(/\s*```$/, '')
  return s
}

/** Deep-merge source into target (arrays replaced, objects merged) */
function deepMerge(target, source) {
  if (!source) return
  for (const key in source) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      if (!target[key]) target[key] = {}
      deepMerge(target[key], source[key])
    } else if (Array.isArray(source[key])) {
      target[key] = [...source[key]]
    } else if (source[key] !== null && source[key] !== undefined) {
      target[key] = source[key]
    }
  }
}

/** Merge turn_index by turn_id: keep all turns, update from new list */
function mergeTurnIndex(prev, next) {
  const byId = new Map((prev || []).map(t => [t.turn_id, t]))
  for (const t of next || []) {
    if (t?.turn_id != null) byId.set(t.turn_id, t)
  }
  return Array.from(byId.values()).sort((a, b) => (a.turn_id || '').localeCompare(b.turn_id || ''))
}

/**
 * Build preamble for old mental model (Streamlit-style: expectations, role).
 * mm: { user_certainty, model_seen_as_expert, expects_correction, validation_seeking, ... }
 */
function buildPreambleOld(mm) {
  if (!mm) return ''
  const n = (v) => (typeof v === 'number' ? v.toFixed(2) : v)
  return `You are an assistant responding to a user. Before answering, read this
description of the user's inferred conversational expectations and goals.
Use it to shape your tone and structure, but do NOT restate it explicitly.

[Epistemic stance]
- User certainty (0–1): ${n(mm.user_certainty)}
- User treats assistant as expert (0–1): ${n(mm.model_seen_as_expert)}
- Expects explicit correction: ${mm.expects_correction}

[Relational goals]
- Validation seeking (0–1): ${n(mm.validation_seeking)}
- Objectivity seeking (0–1): ${n(mm.objectivity_seeking)}
- Empathy expectation (0–1): ${n(mm.empathy_expectation)}

[Style]
- Directness (0–1): ${n(mm.directness)}
- Informativeness (0–1): ${n(mm.informativeness)}

[Role]
- Assistant role: ${mm.assistant_role ?? 'Neutral assistant'}`
}

/**
 * Build preamble for new mental model (person perception + situation log).
 * mm: { behavior, mental_state, motives_goals, long_term, memory }
 */
function buildPreambleNew(mm) {
  if (!mm) return ''
  const lines = []
  lines.push(`You are an assistant responding to a user. Before answering, read this
inferred person perception and situation context. Use it to shape your tone and structure, but do NOT restate it explicitly.`)

  // Behavior / observations
  if (mm.behavior?.observations?.length) {
    lines.push('\n[Observed behavior this turn]')
    mm.behavior.observations.forEach((obs, i) => {
      if (obs.observed_evidence) lines.push(`- ${obs.observed_evidence}`)
      const d = obs.diagnosticity
      if (d && (d.situational_force != null || d.consistency != null)) {
        lines.push(`  Situational force: ${d.situational_force ?? '—'}, Consistency: ${d.consistency ?? '—'}`)
      }
    })
  }

  // Mental state
  const ms = mm.mental_state
  if (ms) {
    lines.push('\n[Mental state (turn-level)]')
    if (ms.mind3d) {
      const m = ms.mind3d
      lines.push(`- Mind3d: rationality ${m.rationality ?? '—'}, valence ${m.valence ?? '—'}, social_impact ${m.social_impact ?? '—'}`)
    }
    if (ms.immediate_intent?.label) lines.push(`- Immediate intent: ${ms.immediate_intent.label} (${((ms.immediate_intent.confidence ?? 0) * 100).toFixed(0)}%)`)
    if (ms.horizontal_warmth != null) lines.push(`- Horizontal warmth (cooperative): ${ms.horizontal_warmth}`)
    if (ms.vertical_competence != null) lines.push(`- Vertical competence: ${ms.vertical_competence}`)
    if (ms.role_hypothesis?.label) lines.push(`- Role hypothesis: ${ms.role_hypothesis.label}`)
    if (ms.user_model_of_llm?.label) lines.push(`- User model of LLM: ${ms.user_model_of_llm.label}`)
  }

  // Motives & goals
  const mg = mm.motives_goals
  if (mg) {
    if (mg.inferred_motives?.length) {
      lines.push('\n[Inferred motives]')
      mg.inferred_motives.forEach((m) => {
        if (m?.label) lines.push(`- ${m.label}${m.confidence != null ? ` (${(m.confidence * 100).toFixed(0)}%)` : ''}`)
      })
    }
    if (mg.goal?.label) {
      lines.push('\n[Goal]')
      lines.push(`- ${mg.goal.label}${mg.goal.confidence != null ? ` (${(mg.goal.confidence * 100).toFixed(0)}%)` : ''}`)
    }
  }

  // Long-term items (candidates/traits)
  if (mm.long_term?.items?.length) {
    lines.push('\n[Long-term hypotheses]')
    mm.long_term.items.forEach((item) => {
      if (item?.label) lines.push(`- ${item.label} (${item.status ?? 'candidate'}, ${item.type ?? 'other'})`)
    })
  }

  // Situation log (memory)
  const mem = mm.memory
  if (mem?.situation_log) {
    const sl = mem.situation_log
    lines.push('\n[Situation context]')
    if (sl.summary) lines.push(`- Summary: ${sl.summary}`)
    if (sl.facts?.length) {
      sl.facts.forEach((f) => {
        const fact = typeof f === 'object' && f != null && 'fact' in f ? f.fact : f
        if (fact) lines.push(`- Fact: ${fact}`)
      })
    }
  }

  return lines.join('\n')
}

/**
 * Build mental-model preamble for the response LLM. useOldModel true => old format, false => new (person perception + situation log).
 */
function buildMentalModelPreamble(useOldModel, mentalModel) {
  if (!mentalModel) return ''
  return useOldModel ? buildPreambleOld(mentalModel) : buildPreambleNew(mentalModel)
}

export const sendMessageToLLM = async (message, conversationHistory = [], context = {}) => {
  requireCurrentProviderEnv()

  const { useOldModel = false, mentalModel = null } = context
  const preamble = buildMentalModelPreamble(useOldModel, mentalModel)
  const systemContent = preamble
    ? preamble + '\n\nRespond to the user. Use the mental model above to shape your tone and structure; do not restate it explicitly.'
    : 'You are a helpful assistant.'

  const messages = [
    { role: 'system', content: systemContent },
    ...conversationHistory.map(msg => ({ role: msg.role, content: msg.content })),
    { role: 'user', content: message }
  ]

  console.log('[API sendMessageToLLM] system:', systemContent)
  console.log('[API sendMessageToLLM] messages (full):', messages)

  try {
    return await chatCompletion(messages)
  } catch (error) {
    console.error('API error:', error)
    throw error
  }
}

export const inferUncertainAssumptions = async (conversationHistory = []) => {
  requireCurrentProviderEnv()

  // Ensure we have conversation content
  if (!conversationHistory || conversationHistory.length === 0) {
    return { assumptions: [] }
  }

  // Build conversation text using exact same approach as Python code (build_history_text)
  const buildHistoryText = (messages) => {
    const lines = []
    for (const m of messages) {
      const role = m.role === 'user' ? 'User' : 'Assistant'
      lines.push(`${role}: ${m.content}`)
    }
    return lines.join('\n')
  }

  const conversationText = buildHistoryText(conversationHistory)
  
  // Ensure we have actual conversation content
  if (!conversationText || conversationText.trim().length === 0) {
    return { assumptions: [] }
  }

  // Exact prompts from Python code
  const systemMsg = (
    "Before answering, pause and reconsider assumptions. " +
    "Output uncertain assumptions about the user and their situation, with probabilities, " +
    "in JSON format ONLY. Do not include any additional text."
  )

  const userMsg = `Conversation so far (most recent at bottom):
${conversationText}

Return STRICT JSON with this schema:

{
  "assumptions": [
    {
      "assumption": "string",
      "probability": 0.0,
      "evidence": "string (brief quote/paraphrase cue from the conversation, optional)"
    }
  ]
}

Rules:
- Provide 3 to 8 assumptions.
- Probabilities must be between 0 and 1.
- Assumptions should be *uncertain* (not obvious facts).
- Keep assumptions specific and conversationally relevant.
- Output JSON only.`

  const messages = [
    { role: 'system', content: systemMsg },
    { role: 'user', content: userMsg }
  ]

  console.log('[API inferUncertainAssumptions] system:', systemMsg)
  console.log('[API inferUncertainAssumptions] user:', userMsg)

  try {
    const responseText = await chatCompletion(messages)

    // Parse JSON (exact same as Python: json.loads(resp.output_text))
    const parsed = JSON.parse(responseText)

    // Light validation/sanitization (from Python code)
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.assumptions)) {
      throw new Error('Assumptions JSON did not match expected shape.')
    }

    const cleaned = []
    for (const item of parsed.assumptions.slice(0, 10)) {
      if (!item || typeof item !== 'object' || !item.assumption || typeof item.probability === 'undefined') {
        continue
      }
      const prob = Math.max(0.0, Math.min(1.0, parseFloat(item.probability)))
      cleaned.push({
        assumption: String(item.assumption),
        probability: prob,
        evidence: String(item.evidence || ''),
      })
    }

    return { assumptions: cleaned }
  } catch (error) {
    console.error('Failed to parse assumptions JSON:', error)
    // Return empty assumptions on error (like Python code)
    return { assumptions: [] }
  }
}

// OLD MENTAL MODEL (Sycophancy + Assumption Model) - kept for toggle
export const inferMentalModelOld = async (userMessage) => {
  requireCurrentProviderEnv()

  // Default mental model (from Python code)
  const DEFAULT_MM = {
    user_certainty: 0.5,
    model_seen_as_expert: 0.8,
    expects_correction: true,
    validation_seeking: 0.5,
    objectivity_seeking: 0.5,
    empathy_expectation: 0.5,
    directness: 0.5,
    informativeness: 0.7,
    assistant_role: "Neutral assistant",
  }

  // Exact prompts from Python code
  const systemMsg = (
    "You analyze a single user message and infer the user's conversational expectations. " +
    "Output STRICT JSON ONLY (no markdown, no comments)."
  )

  const userMsg = `User message:
${userMessage}

Return a JSON object with exactly these keys:

- user_certainty (float 0–1)
- model_seen_as_expert (float 0–1)
- expects_correction (boolean)
- validation_seeking (float 0–1)
- objectivity_seeking (float 0–1)
- empathy_expectation (float 0–1)
- directness (float 0–1)
- informativeness (float 0–1)
- assistant_role (string, one of: "Neutral assistant", "Expert", "Friend/peer", "Therapist-like listener")

Output STRICT JSON only.`

  const messages = [
    {
      role: 'system',
      content: systemMsg
    },
    {
      role: 'user',
      content: userMsg
    }
  ]

  console.log('[API inferMentalModelOld] system:', systemMsg)
  console.log('[API inferMentalModelOld] user:', userMsg)

  try {
    const responseText = await chatCompletion(messages)

    // Parse JSON (exact same as Python: json.loads(resp.output_text))
    const mm = JSON.parse(responseText)
    
    // Clean and merge with defaults (from Python code)
    const cleaned = { ...DEFAULT_MM }
    for (const k in cleaned) {
      if (k in mm) {
        cleaned[k] = mm[k]
      }
    }
    
    return cleaned
  } catch (error) {
    console.error('Failed to parse mental-model JSON, using defaults:', error)
    // Return defaults on error (from Python code)
    return DEFAULT_MM
  }
}

const CONVO_HISTORY_LAST_N_MESSAGES = 3

// NEW MENTAL MODEL (TurnState + Person Perception)
export const inferMentalModel = async (userMessage, turnId, memory = { turn_index: [], situation_log: {} }, conversationHistory = []) => {
  requireCurrentProviderEnv()

  // Default mental model structure (matches API response: person_perception + memory)
  const DEFAULT_MM = {
    behavior: {
      turn_id: turnId,
      text: userMessage,
      observations: [
        {
          observed_evidence: "",
          diagnosticity: {
            situational_force: 0.0,
            consistency: 0.0
          }
        }
      ]
    },
    mental_state: {
      mind3d: {
        rationality: 0.0,
        valence: 0.0,
        social_impact: 0.0
      },
      immediate_intent: { label: "", confidence: 0.0 },
      horizontal_warmth: 0.0,
      vertical_competence: 0.0,
      role_hypothesis: { label: "", confidence: 0.0 },
      user_model_of_llm: { label: "", confidence: 0.0 }
    },
    motives_goals: {
      inferred_motives: [
        { label: "", confidence: 0.0 }
      ],
      goal: { label: "", confidence: 0.0 }
    },
    long_term: {
      items: []
    },
    memory: {
      situation_log: { summary: "", facts: [] },
      turn_index: [
        { turn_id: turnId, person_perception: {
            "anyOf": [
              { "type": "string" },
              { "type": "object" }
            ]
          }
       }
      ]
    }
  }

  // Build memory text: full situation_log + only the previous turn's person_perception (prompt stays short). Full turn_index is still merged and stored.
  const memoryText = (() => {
    const log = memory.situation_log
    const idx = memory.turn_index || []
    const parts = []
    parts.push("Previous situation_log (take this in as a whole; return your updated version in memory):")
    parts.push("summary: " + (log?.summary || "(none)"))
    parts.push("facts: " + (log?.facts?.length ? JSON.stringify(log.facts) : "[]"))
    if (idx.length) {
      const prev = idx[idx.length - 1]
      const prevStr = typeof prev.person_perception === 'string' ? prev.person_perception : (prev.notes ?? JSON.stringify(prev.person_perception ?? ''))
      parts.push("Previous turn's person_perception only (for context; return your full updated turn_index in memory):")
      parts.push(`${prev.turn_id}: ${prevStr}`)
    }
    return parts.join("\n")
  })()

  // Recent conversation (last 2 turns) for context
  const recentConvoText = (() => {
    if (!conversationHistory?.length) return ''
    const last = conversationHistory.slice(-CONVO_HISTORY_LAST_N_MESSAGES)
    const lines = last.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    return lines.length ? `Recent conversation:\n${lines.join('\n')}\n\n` : ''
  })()

  // System message: role + JSON format and filling instructions
  const systemMsg = `You analyze a user message and infer person perception + memory.
Output STRICT JSON ONLY (no markdown, no comments, no extra keys). Do not output any text before or after the JSON. Do not wrap in code fences.

Required output structure (use the turn_id and user message from the user message below for behavior.turn_id and behavior.text):

{
  "person_perception": {
    "behavior": {
      "turn_id": "<from user message>",
      "text": "<from user message>",
      "observations": [
        {
          "observed_evidence": "",
          "diagnosticity": { "situational_force": 0.0, "consistency": 0.0 }
        }
      ]
    },
    "mental_state": {
      "mind3d": { "rationality": 0.0, "valence": 0.0, "social_impact": 0.0 },
      "immediate_intent": { "label": "", "confidence": 0.0 },
      "horizontal_warmth": 0.0,
      "vertical_competence": 0.0,
      "role_hypothesis": { "label": "", "confidence": 0.0 },
      "user_model_of_llm": { "label": "", "confidence": 0.0 }
    },
    "motives_goals": {
      "inferred_motives": [{ "label": "", "confidence": 0.0 }],
      "goal": { "label": "", "confidence": 0.0 }
    },
    "long_term": {
      "items": [{ "label": "", "type": "preference", "status": "candidate", "confidence": 0.0, "evidence_turn_ids": [] }]
    }
  },
  "memory": {
    "situation_log": { "summary": "", "facts": [{ "fact": "", "turn_id": "<from user message>" }] },
    "turn_index": [{ "turn_id": "<from user message>", "person_perception": {} }]
  }
}

FILLING INSTRUCTIONS:

1) behavior.observations (1+ items per turn)
- observed_evidence: short description of what was observed (surface cues, context)
- diagnosticity: situational_force [0,1] = how much the situation explains behavior (higher = less person-diagnostic); consistency [0,1] = whether behavior is consistent with memory (first time = 0.0)

2) mental_state (turn-level; do NOT treat as traits)
- mind3d: rationality [-1,1] reacting/feeling vs thinking/planning; valence [-1,1] negative vs positive; social_impact [-1,1] low vs high intensity
- immediate_intent: communicated goal of the user right now (short label)
- horizontal_warmth [0,1]: cooperative vs competitive
- vertical_competence [0,1]: clarity/ability to act on intent
- role_hypothesis, user_model_of_llm: your role and what the user views you as

3) motives_goals: inferred from current message and conversation history
- inferred_motives: 1–3 hypotheses; goal: best guess of what success looks like for the session

4) long_term.items: persistent rolling list (0–5 items). status: candidate or trait; type: preference|tendency|other. Update from previous turn.

5) memory: Take in "Previous memory" (situation_log + previous turn's person_perception). Return updated situation_log (summary + facts) and full turn_index. Prefer full person_perception for current and optionally previous turn; use short notes or "" for older turns.`

  const userMsg = `${recentConvoText}User message (turn ${turnId}):
${userMessage}

Previous memory:
${memoryText}

Return the JSON for turn ${turnId} with behavior.turn_id and behavior.text set to the user message above. Output only the JSON.`

  const messages = [
    {
      role: 'system',
      content: systemMsg
    },
    {
      role: 'user',
      content: userMsg
    }
  ]

  console.log('[API inferMentalModel] system:', systemMsg)
  console.log('[API inferMentalModel] user:', userMsg)

  try {
    const content = await chatCompletion(messages)
    const jsonText = stripJsonFences(content)
    const mm = JSON.parse(jsonText)

    const raw = mm.person_perception
      ? { ...mm.person_perception, memory: mm.memory }
      : mm

    const cleaned = JSON.parse(JSON.stringify(DEFAULT_MM))
    deepMerge(cleaned, raw)
    cleaned.behavior.turn_id = turnId
    cleaned.behavior.text = userMessage

    cleaned.memory.turn_index = mergeTurnIndex(memory?.turn_index, raw.memory?.turn_index)

    const prevLog = memory?.situation_log ?? {}
    const newLog = raw.memory?.situation_log ?? {}
    const useNewFacts = Array.isArray(newLog.facts)
    cleaned.memory.situation_log = {
      summary: newLog.summary ?? prevLog.summary ?? '',
      facts: useNewFacts ? newLog.facts : (prevLog.facts ?? [])
    }

    return cleaned
  } catch (error) {
    if (isRateLimitError(error) || isTimeoutError(error) || isNetworkError(error)) throw error
    console.error('Failed to parse mental-model JSON, using defaults:', error)
    const fallback = JSON.parse(JSON.stringify(DEFAULT_MM))
    fallback.behavior.turn_id = turnId
    fallback.behavior.text = userMessage
    fallback.memory = memory ? { ...memory } : fallback.memory
    return fallback
  }
}

/** One completion call with a single user message; returns content string. */
async function completionWithUserMessage(prompt) {
  return chatCompletion([{ role: 'user', content: prompt }])
}

/**
 * Single chat completion that routes to Azure (gpt-4o) or Gemini based on apiProvider.
 * messages: [{ role: 'system'|'user'|'assistant', content: string }, ...]
 * Returns the assistant reply content string.
 */
async function chatCompletion(messages) {
  requireCurrentProviderEnv()
  if (apiProvider === 'gemini') {
    return chatCompletionGemini(messages)
  }
  if (apiProvider === 'llama') {
    return chatCompletionLlamaVertex(messages)
  }
  return chatCompletionAzure(messages)
}

async function chatCompletionAzure(messages) {
  requireAzureEnv()
  const c = getEffectiveAzureConfig()
  const apiUrl = `${c.endpoint}openai/deployments/${c.deployment}/chat/completions?api-version=${c.apiVersion}`
  const response = await fetchWithTimeout(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': c.apiKey },
    body: JSON.stringify({
      messages,
      max_completion_tokens: DEFAULT_MAX_COMPLETION_TOKENS,
      temperature: DEFAULT_TEMPERATURE,
      top_p: DEFAULT_TOP_P,
      model: c.deployment,
    }),
  })
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}))
    throw new Error(errorData.error?.message || `API request failed with status ${response.status}`)
  }
  const data = await response.json()
  return data.choices?.[0]?.message?.content ?? ''
}

async function chatCompletionGemini(messages) {
  const isNode = typeof process !== 'undefined' && process.versions?.node
  const useVertex = isNode && GOOGLE_APPLICATION_CREDENTIALS
  if (useVertex) {
    return chatCompletionGeminiVertex(messages)
  }
  requireGeminiEnv()
  let systemInstruction = ''
  const chatMessages = []
  for (const m of messages) {
    if (m.role === 'system') {
      systemInstruction = (systemInstruction ? systemInstruction + '\n\n' : '') + (m.content || '')
    } else {
      chatMessages.push({ role: m.role === 'assistant' ? 'model' : 'user', content: m.content || '' })
    }
  }
  const contents = []
  for (const m of chatMessages) {
    contents.push({ role: m.role, parts: [{ text: m.content }] })
  }
  const body = {
    contents,
    generationConfig: {
      maxOutputTokens: DEFAULT_MAX_COMPLETION_TOKENS,
      temperature: DEFAULT_TEMPERATURE,
      topP: DEFAULT_TOP_P,
    },
  }
  if (systemInstruction) body.systemInstruction = { parts: [{ text: systemInstruction }] }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}))
    throw new Error(errorData.error?.message || `Gemini API failed: ${response.status}`)
  }
  const data = await response.json()
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text
  if (text == null) throw new Error('Gemini response missing text')
  return text
}

/**
 * Get a Vertex AI access token using service account credentials from keyPath.
 * Uses JWT client with explicit credentials to avoid invalid_scope errors that can
 * occur with GoogleAuth.getClient() (e.g. when the key has API restrictions).
 */
async function getVertexAccessToken(keyPath) {
  const { readFileSync } = await import('fs')
  const { JWT } = await import('google-auth-library')
  let keyContent
  try {
    keyContent = readFileSync(keyPath, 'utf8')
  } catch (e) {
    throw new Error(`Failed to read credentials from ${keyPath}: ${e.message}`)
  }
  let key
  try {
    key = JSON.parse(keyContent)
  } catch (e) {
    throw new Error(`Invalid JSON in ${keyPath}: ${e.message}`)
  }
  if (!key.client_email || !key.private_key) {
    throw new Error(`${keyPath} must contain client_email and private_key (service account JSON)`)
  }
  const client = new JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  })
  const res = await client.getAccessToken()
  return res?.token ?? null
}

/**
 * Gemini via Vertex AI (Node only). Uses GOOGLE_APPLICATION_CREDENTIALS path to service-account JSON.
 * Project ID from VITE_GEMINI_PROJECT_ID / GEMINI_PROJECT_ID or from the JSON file.
 */
async function chatCompletionGeminiVertex(messages) {
  const { readFileSync } = await import('fs')
  const keyPath = GOOGLE_APPLICATION_CREDENTIALS
  if (!keyPath) {
    throw new Error('Gemini Vertex: set GOOGLE_APPLICATION_CREDENTIALS=path/to/service_account.json in .env')
  }

  let projectId = GEMINI_PROJECT_ID
  if (!projectId) {
    try {
      const keyContent = readFileSync(keyPath, 'utf8')
      const keyJson = JSON.parse(keyContent)
      projectId = keyJson.project_id || ''
    } catch (e) {
      throw new Error(`Failed to read service account from ${keyPath}: ${e.message}. Set VITE_GEMINI_PROJECT_ID in .env`)
    }
  }
  if (!projectId) throw new Error('Gemini Vertex: set VITE_GEMINI_PROJECT_ID in .env or ensure service account JSON has project_id')

  const token = await getVertexAccessToken(keyPath)
  if (!token) throw new Error('Failed to get Vertex AI access token')

  let systemInstruction = ''
  const chatMessages = []
  for (const m of messages) {
    if (m.role === 'system') {
      systemInstruction = (systemInstruction ? systemInstruction + '\n\n' : '') + (m.content || '')
    } else {
      chatMessages.push({ role: m.role === 'assistant' ? 'model' : 'user', content: m.content || '' })
    }
  }
  const contents = chatMessages.map(m => ({ role: m.role, parts: [{ text: m.content }] }))
  const body = {
    contents,
    generationConfig: {
      maxOutputTokens: DEFAULT_MAX_COMPLETION_TOKENS,
      temperature: DEFAULT_TEMPERATURE,
      topP: DEFAULT_TOP_P,
    },
  }
  if (systemInstruction) body.systemInstruction = { parts: [{ text: systemInstruction }] }

  const url = `https://${GEMINI_LOCATION}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${GEMINI_LOCATION}/publishers/google/models/${GEMINI_MODEL}:generateContent`
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const errText = await response.text()
    let errMsg = `Vertex Gemini API failed: ${response.status}`
    try {
      const errJson = JSON.parse(errText)
      if (errJson.error?.message) errMsg = errJson.error.message
    } catch (_) {}
    throw new Error(errMsg)
  }
  const data = await response.json()
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text
  if (text == null) throw new Error('Vertex Gemini response missing text')
  return text
}

/**
 * Llama via Vertex AI (Node only). Uses same GOOGLE_APPLICATION_CREDENTIALS as Gemini Vertex.
 * Endpoint: Vertex AI OpenAPI-style chat/completions (OpenAI-compatible response).
 * Env: LLAMA_PROJECT_ID, LLAMA_LOCATION (default us-central1), LLAMA_MODEL_ID (e.g. meta/llama-3.3-70b-instruct-maas).
 */
async function chatCompletionLlamaVertex(messages) {
  const { readFileSync } = await import('fs')
  const keyPath = GOOGLE_APPLICATION_CREDENTIALS
  if (!keyPath) {
    throw new Error('Llama Vertex: set GOOGLE_APPLICATION_CREDENTIALS=path/to/service_account.json in .env')
  }

  let projectId = LLAMA_PROJECT_ID
  if (!projectId) {
    try {
      const keyContent = readFileSync(keyPath, 'utf8')
      const keyJson = JSON.parse(keyContent)
      projectId = keyJson.project_id || ''
    } catch (e) {
      throw new Error(`Failed to read service account from ${keyPath}: ${e.message}. Set LLAMA_PROJECT_ID in .env`)
    }
  }
  if (!projectId) throw new Error('Llama Vertex: set LLAMA_PROJECT_ID or VITE_LLAMA_PROJECT_ID in .env')

  const token = await getVertexAccessToken(keyPath)
  if (!token) throw new Error('Failed to get Vertex AI access token for Llama')

  // Vertex OpenAPI chat/completions expects OpenAI-style messages and returns choices[0].message.content
  const payload = {
    model: LLAMA_MODEL_ID,
    messages: messages.map(m => ({ role: m.role, content: m.content || '' })),
    max_tokens: DEFAULT_MAX_COMPLETION_TOKENS,
    temperature: DEFAULT_TEMPERATURE,
  }

  const url = `https://${LLAMA_LOCATION}-aiplatform.googleapis.com/v1beta1/projects/${projectId}/locations/${LLAMA_LOCATION}/endpoints/openapi/chat/completions`
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  })
  if (!response.ok) {
    const errText = await response.text()
    let errMsg = `Vertex Llama API failed: ${response.status}`
    try {
      const errJson = JSON.parse(errText)
      if (errJson.error?.message) errMsg = errJson.error.message
    } catch (_) {}
    throw new Error(errMsg)
  }
  const data = await response.json()
  const text = data?.choices?.[0]?.message?.content
  if (text == null) throw new Error('Vertex Llama response missing content')
  return text
}

/** Build turnsWithPriors from flat conversationHistory and per-turn mental models. */
function buildTurnsWithPriors(conversationHistory, priorMentalModelsByTurn) {
  const turnsWithPriors = []
  for (let i = 0; i + 1 < conversationHistory.length; i += 2) {
    const u = conversationHistory[i]
    const a = conversationHistory[i + 1]
    if (u?.role === 'user' && a?.role === 'assistant') {
      const turnIndex = turnsWithPriors.length
      turnsWithPriors.push({
        userMessage: typeof u.content === 'string' ? u.content : '',
        assistantMessage: typeof a.content === 'string' ? a.content : '',
        mentalModel: priorMentalModelsByTurn?.[turnIndex] ?? null
      })
    }
  }
  return turnsWithPriors
}

/**
 * Single-call flow: one prompt with conversation + User A says + mental model instructions + JSON + RESPONSE.
 * Returns { mentalModel, response }.
 * priorMentalModelsByTurn: optional array of mental models (one per completed turn); when set, prior scores are shown after each turn in the conversation log.
 */
export const sendMessageWithInlineMentalModel = async (conversationHistory, newUserText, modelType, priorMentalModelsByTurn = null) => {
  const historyStr = conversationHistory.length
    ? conversationHistory.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n\n')
    : ''
  const turnsWithPriors = Array.isArray(priorMentalModelsByTurn) && priorMentalModelsByTurn.length > 0
    ? buildTurnsWithPriors(conversationHistory, priorMentalModelsByTurn)
    : null
  if (turnsWithPriors?.length) {
    console.log('[API] Prior (all past turns, scores only) in conversation log:\n', buildHistoryBlockWithPriors(turnsWithPriors))
  }
  const prompt = buildPromptWithHistory(historyStr, newUserText, modelType, turnsWithPriors)
  console.log('[API] Single call: mental model + response', { modelType, promptLength: prompt.length })
  console.log('[API] Single call — full prompt (with conversation + user message):\n', prompt)
  const content = await completionWithUserMessage(prompt)
  return parseSingleCallResponse(content)
}

/**
 * One-call flow: mental model only (used when separate mode uses pre-existing convos from convos_to_use).
 * Returns { mentalModel }.
 * priorMentalModelsByTurn: optional array of mental models (one per completed turn); when set, prior scores are shown after each turn in the conversation log.
 */
export const sendMessageMentalModelOnly = async (conversationHistory, newUserText, modelType, priorMentalModelsByTurn = null) => {
  const historyStr = conversationHistory.length
    ? conversationHistory.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n\n')
    : ''
  const turnsWithPriors = Array.isArray(priorMentalModelsByTurn) && priorMentalModelsByTurn.length > 0
    ? buildTurnsWithPriors(conversationHistory, priorMentalModelsByTurn)
    : null
  if (turnsWithPriors?.length) {
    console.log('[API] Prior (all past turns, scores only) in conversation log:\n', buildHistoryBlockWithPriors(turnsWithPriors))
  }
  const prompt = buildMentalModelOnlyPrompt(historyStr, newUserText, modelType, turnsWithPriors)
  console.log('[API] Mental model only (convos_to_use mode)', { modelType, promptLength: prompt.length })
  const content = await completionWithUserMessage(prompt)
  const mentalModel = parseMentalModelOnlyResponse(content)
  return { mentalModel }
}

/**
 * Separate two-call flow: call 1 = mental model only (JSON), call 2 = response only (RESPONSE: ...). Calls do not affect each other.
 * Returns { mentalModel, response }. Saves convo JSON the same way as single-call.
 * When using pre-existing convos (run_simulations with useSeparateMentalModelResponse), only the mental-model call is made; user/assistant text comes from convos_to_use.
 * priorMentalModelsByTurn: optional array of mental models (one per completed turn); when set, prior scores are shown after each turn in the conversation log.
 */
export const sendMessageSeparateMentalModelAndResponse = async (conversationHistory, newUserText, modelType, priorMentalModelsByTurn = null) => {
  const historyStr = conversationHistory.length
    ? conversationHistory.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n\n')
    : ''

  const turnsWithPriors = Array.isArray(priorMentalModelsByTurn) && priorMentalModelsByTurn.length > 0
    ? buildTurnsWithPriors(conversationHistory, priorMentalModelsByTurn)
    : null
  if (turnsWithPriors?.length) {
    console.log('[API] Prior (all past turns, scores only) in conversation log:\n', buildHistoryBlockWithPriors(turnsWithPriors))
  }
  const prompt1 = buildMentalModelOnlyPrompt(historyStr, newUserText, modelType, turnsWithPriors)
  console.log('[API] Separate mode: call 1 (mental model only)', { modelType, promptLength: prompt1.length })
  console.log('[API] Separate call 1 — full prompt (mental model only, with conversation + user message):\n', prompt1)
  const content1 = await completionWithUserMessage(prompt1)
  const mentalModel = parseMentalModelOnlyResponse(content1)

  const prompt2 = buildResponseOnlyPrompt(historyStr, newUserText)
  console.log('[API] Separate mode: call 2 (response only)', { modelType, promptLength: prompt2.length })
  console.log('[API] Separate call 2 — full prompt (response only, with conversation + user message):\n', prompt2)
  const content2 = await completionWithUserMessage(prompt2)
  const response = parseResponseOnlyContent(content2)

  return { mentalModel, response }
}

/**
 * Response-only call (no mental model). Used for --generate_convo to produce assistant replies.
 */
export const sendResponseOnly = async (conversationHistory, newUserText) => {
  const historyStr = conversationHistory.length
    ? conversationHistory.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n\n')
    : ''
  const prompt = buildResponseOnlyPrompt(historyStr, newUserText)
  const content = await completionWithUserMessage(prompt)
  return parseResponseOnlyContent(content)
}

/** Context window (input + output). Output reserved for mental-model JSON. */
const CONTEXT_WINDOW_MAX_TOKENS = 128000
const OUTPUT_RESERVE_TOKENS = 5000
/** Generous estimate: ~4 chars per token (100 tokens ~ 75 words). */
const CHARS_PER_TOKEN = 4
const MENTAL_MODEL_PROMPT_OVERHEAD_TOKENS = 4000

/** Estimate token count from character length. */
function estimateTokens(str) {
  if (!str || typeof str !== 'string') return 0
  return Math.ceil(str.length / CHARS_PER_TOKEN)
}

/** Max tokens allowed for conversation + current user message (so total input + output <= CONTEXT_WINDOW_MAX_TOKENS). */
const MAX_INPUT_ESTIMATE_TOKENS = CONTEXT_WINDOW_MAX_TOKENS - OUTPUT_RESERVE_TOKENS - MENTAL_MODEL_PROMPT_OVERHEAD_TOKENS

/** Base URL for pre-existing conversations (served by Vite plugin from data/seperate_call/convos_to_use). */
const CONVOS_TO_USE_BASE = '/data/seperate_call/convos_to_use'

/**
 * Load a pre-existing conversation for (category, prompt_id). Used when separate mental model + response is checked:
 * user/assistant messages come from this file; only one GPT call per turn (mental model).
 * Returns { turns: [{ turnIndex, userMessage, assistantMessage }, ...], ... } or null if fetch fails.
 */
export const loadConvoFromConvosToUse = async (category, promptId) => {
  const url = `${CONVOS_TO_USE_BASE}/${category}/${promptId}.json`
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const data = await res.json()
    if (!data?.turns?.length) return null
    return data
  } catch {
    return null
  }
}

// --- Human data analysis (e.g. h01.json: meta + messages) ---

const HUMAN_DATA_BASE = '/data'

/**
 * Load human conversation JSON from /data path (e.g. do_not_upload/h01.json).
 * Expected shape: { meta: { ... }, messages: [ { role: 'user'|'assistant', content: string }, ... ] }.
 */
export const loadHumanDataJson = async (dataPath) => {
  const url = dataPath.startsWith('/') ? `${HUMAN_DATA_BASE}${dataPath}` : `${HUMAN_DATA_BASE}/${dataPath}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to load human data: ${res.status} ${url}`)
  const data = await res.json()
  if (!data?.messages?.length) throw new Error('Human data has no messages array')
  return data
}

/**
 * Convert messages to turns: [ { turnIndex, userMessage, assistantMessage }, ... ].
 * Consecutive user messages are merged (joined with '\n\n') and paired with the next assistant message.
 */
function messagesToTurns(messages) {
  const turns = []
  let i = 0
  while (i < messages.length) {
    const userContents = []
    while (i < messages.length && messages[i]?.role === 'user') {
      const content = messages[i].content
      userContents.push(typeof content === 'string' ? content : '')
      i++
    }
    if (userContents.length === 0) {
      i++
      continue
    }
    const userMessage = userContents.join('\n\n')
    if (i >= messages.length || messages[i]?.role !== 'assistant') {
      continue
    }
    const assistantMessage = typeof messages[i].content === 'string' ? messages[i].content : ''
    turns.push({
      turnIndex: turns.length,
      userMessage,
      assistantMessage
    })
    i++
  }
  return turns
}

/**
 * Trim conversation history (array of { role, content }) so that estimated tokens for
 * historyStr + newUserText is <= maxTokens. Mutates by removing from the start.
 */
function trimHistoryToTokenLimit(history, newUserText, maxTokens) {
  const newUserEst = estimateTokens(newUserText)
  let historyStr = history.length
    ? history.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n\n')
    : ''
  while (history.length > 0 && estimateTokens(historyStr) + newUserEst > maxTokens) {
    history.shift()
    history.shift()
    historyStr = history.length
      ? history.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n\n')
      : ''
  }
}

/**
 * Return true if this turn's mentalModel is empty or missing required content for human eval.
 * induct: needs mental_model.beliefs; types_support: needs mental_model.support_seeking.
 */
export function isEmptyMentalModel(mentalModel, mentalModelType) {
  if (!mentalModel || typeof mentalModel !== 'object') return true
  const mm = mentalModel.mental_model ?? mentalModel.mentalModel
  if (!mm || typeof mm !== 'object') return true
  if (mentalModelType === 'induct') return !mm.beliefs || typeof mm.beliefs !== 'object'
  if (mentalModelType === 'types_support') return !mm.support_seeking || typeof mm.support_seeking !== 'object'
  return true
}

/**
 * Backfill empty mental models in an existing human-eval result (e.g. from runHumanDataAnalysis).
 * result: { meta, turns } with turns[].{ turnIndex, userMessage, assistantMessage, mentalModel }.
 * For each turn where mentalModel is empty, calls sendMessageMentalModelOnly and updates the turn.
 * Uses same context trimming and prior logic as runHumanDataAnalysis.
 * Returns updated { meta, turns } (mutates result.turns in place and updates meta.last_updated).
 */
export const backfillEmptyMentalModelsForHumanResult = async ({
  result,
  mentalModelType = 'induct',
  onProgress = null,
  onTurn = null
} = {}) => {
  requireCurrentProviderEnv()
  if (!['induct', 'types_support'].includes(mentalModelType)) {
    throw new Error('Backfill only supports mentalModelType: induct or types_support')
  }
  const turns = result?.turns
  if (!Array.isArray(turns) || !turns.length) return result

  const emptyIndices = turns
    .map((t, i) => (isEmptyMentalModel(t.mentalModel, mentalModelType) ? i : -1))
    .filter(i => i >= 0)
  if (emptyIndices.length === 0) return result

  for (const t of emptyIndices) {
    const turn = turns[t]
    const history = []
    for (let i = 0; i < t; i++) {
      history.push({ role: 'user', content: turns[i].userMessage })
      history.push({ role: 'assistant', content: turns[i].assistantMessage })
    }
    trimHistoryToTokenLimit(history, turn.userMessage, MAX_INPUT_ESTIMATE_TOKENS)

    // Human data: no prior mental model in the prompt, just conversation up to this point
    const apiResult = await withRetryOnRateLimit(() =>
      sendMessageMentalModelOnly(history, turn.userMessage, mentalModelType, null)
    )
    turn.mentalModel = apiResult.mentalModel ?? {}
    result.meta = result.meta || {}
    result.meta.last_updated = new Date().toISOString()
    result.meta.api_model = getApiProvider()
    if (onTurn) onTurn(t, turn.userMessage, turn.assistantMessage, turn.mentalModel)
    if (onProgress) onProgress(t, turns.length, emptyIndices.length)
  }
  return result
}

/**
 * Run mental-model analysis over human conversation data (e.g. h01.json).
 * - Fetches JSON from dataPath (under /data), converts messages to turns (user/assistant pairs).
 * - Respects 128k context: trims earlier messages so prompt + 5k output <= 128k (estimate ~4 chars/token).
 * - One API call per turn (mental model only). Supports induct and types_support.
 * - Saves checkpoint every 50 turns (and at end); metadata has turns_recorded_up_to (single number) for resume.
 * - downloadWhenDone: download as ZIP (runId/human/<sourceId>.json).
 * dataPath: e.g. 'do_not_upload/h01.json'
 * mentalModelType: 'induct' | 'types_support'
 * existingResult: optional { meta: { turns_recorded_up_to, ... }, turns: [...] } to resume from.
 * rawData: optional pre-loaded { meta, messages } (CLI: read from disk and pass); skips loadHumanDataJson.
 * runId: optional (CLI passes e.g. filename_induct_run_1).
 * onSaveCheckpoint: optional (result) => void; when set, called after each checkpoint and at end instead of ZIP download.
 */
const HUMAN_DATA_CHECKPOINT_EVERY_N_TURNS = 50

export const runHumanDataAnalysis = async ({
  dataPath = 'do_not_upload/h01.json',
  mentalModelType = 'induct',
  usePrior = false,
  existingResult = null,
  rawData = null,
  runId: providedRunId = null,
  onProgress = null,
  onTurn = null,
  onSaveCheckpoint = null,
  downloadWhenDone = true
} = {}) => {
  requireCurrentProviderEnv()
  if (!['induct', 'types_support'].includes(mentalModelType)) {
    throw new Error('Human data analysis only supports mentalModelType: induct or types_support')
  }

  const raw = rawData ?? await loadHumanDataJson(dataPath)
  const initialAssistantHistory = []
  if (Array.isArray(raw.messages) && raw.messages.length) {
    for (let i = 0; i < raw.messages.length; i++) {
      const m = raw.messages[i]
      if (m?.role === 'assistant') {
        initialAssistantHistory.push({ role: 'assistant', content: typeof m.content === 'string' ? m.content : '' })
      } else {
        break
      }
    }
  }
  const turns = messagesToTurns(raw.messages)
  const sourceId = dataPath.replace(/\.json$/i, '').split('/').pop() || 'human'
  const runId = providedRunId ?? `human_${sourceId}_${nextRunId('human_analysis')}`

  const byTurn = new Map()
  if (existingResult?.turns?.length) {
    for (const t of existingResult.turns) {
      if (t.turnIndex != null) byTurn.set(t.turnIndex, t)
    }
  }

  const meta = {
    source: dataPath,
    sourceId,
    mentalModelType,
    api_model: getApiProvider(),
    use_prior: !!usePrior,
    message_count: raw.meta?.message_count ?? raw.messages.length,
    turns_recorded_up_to: -1,
    last_updated: null
  }

  for (let t = 0; t < turns.length; t++) {
    if (byTurn.has(t)) {
      const existingTurn = byTurn.get(t)
      meta.turns_recorded_up_to = t
      if (onTurn) onTurn(runId, sourceId, t, existingTurn.userMessage, existingTurn.assistantMessage, existingTurn.mentalModel)
      if (onProgress) onProgress(runId, sourceId, t, turns.length)
      continue
    }

    const { userMessage, assistantMessage } = turns[t]
    const history = initialAssistantHistory.length ? [...initialAssistantHistory] : []
    for (let i = 0; i < t; i++) {
      history.push({ role: 'user', content: turns[i].userMessage })
      history.push({ role: 'assistant', content: turns[i].assistantMessage })
    }
    trimHistoryToTokenLimit(history, userMessage, MAX_INPUT_ESTIMATE_TOKENS)

    const priorMentalModelsByTurn = usePrior ? Array.from({ length: t }, (_, i) => byTurn.get(i)?.mentalModel ?? null) : null
    const result = await withRetryOnRateLimit(() =>
      sendMessageMentalModelOnly(history, userMessage, mentalModelType, priorMentalModelsByTurn)
    )
    const mentalModel = result.mentalModel

    const turnRecord = { turnIndex: t, userMessage, assistantMessage, mentalModel }
    byTurn.set(t, turnRecord)
    meta.turns_recorded_up_to = t
    meta.last_updated = new Date().toISOString()

    if (onTurn) onTurn(runId, sourceId, t, userMessage, assistantMessage, mentalModel)
    if (onProgress) onProgress(runId, sourceId, t, turns.length)

    const outTurns = Array.from(byTurn.entries()).sort((a, b) => a[0] - b[0]).map(([, tr]) => tr)
    if (onSaveCheckpoint) {
      onSaveCheckpoint({ runId, meta: { ...meta }, turns: outTurns })
    } else {
      const shouldCheckpoint = (t + 1) % HUMAN_DATA_CHECKPOINT_EVERY_N_TURNS === 0
      if (shouldCheckpoint) {
        await downloadHumanAnalysisAsZip({ runId, sourceId, meta: { ...meta }, turns: outTurns, downloadFilename: `${runId}_checkpoint.zip` })
      }
    }
  }

  const finalTurns = Array.from(byTurn.entries()).sort((a, b) => a[0] - b[0]).map(([, tr]) => tr)
  if (onSaveCheckpoint) onSaveCheckpoint({ runId, meta, turns: finalTurns })
  else if (downloadWhenDone) {
    await downloadHumanAnalysisAsZip({ runId, sourceId, meta, turns: finalTurns })
  }

  return { runId, meta, turns: finalTurns }
}

/**
 * Build a ZIP containing one file: runId/human/sourceId.json with { meta, turns } and trigger download.
 */
export const downloadHumanAnalysisAsZip = async ({ runId, sourceId, meta, turns, downloadFilename }) => {
  const zip = new JSZip()
  const runFolder = zip.folder(runId)
  const humanFolder = runFolder.folder('human')
  humanFolder.file(`${sourceId}.json`, JSON.stringify({ meta, turns }, null, 2))
  const blob = await zip.generateAsync({ type: 'blob' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = downloadFilename ?? `${runId}.zip`
  a.click()
  URL.revokeObjectURL(a.href)
}

// --- Eval: simulated conversations ---

/** Generate next seeker (user) message given system prompt and conversation history. */
export const generateSeekerMessage = async (systemPrompt, conversationHistory) => {
  requireCurrentProviderEnv()
  const messages = [
    { role: 'system', content: systemPrompt },
    ...conversationHistory.map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: 'Generate the next message the seeker would say. Output only that message, nothing else. No quotes or labels.' }
  ]
  console.log('[API generateSeekerMessage] system:', systemPrompt)
  console.log('[API generateSeekerMessage] messages (full):', messages)
  const content = await chatCompletion(messages)
  return (content ?? '').trim()
}

const EVAL_RUN_COUNT_KEY = 'perception_llm_eval_run_count'

/** Next run id from a persisted count per mental model type: run001, run002, ... In Node (no localStorage) returns run_<timestamp>. */
export function nextRunId(mentalModelType = 'person_perception') {
  try {
    if (typeof localStorage === 'undefined') return `run_${Date.now()}`
    const key = `${EVAL_RUN_COUNT_KEY}_${mentalModelType}`
    const n = parseInt(localStorage.getItem(key) || '0', 10) + 1
    localStorage.setItem(key, String(n))
    return `run${String(n).padStart(3, '0')}`
  } catch {
    return `run_${Date.now()}`
  }
}

/** Build scenario payload: turns with situation_log stripped from each mentalModel.memory; situation_log only at end (from last turn). */
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

/**
 * Build a ZIP with structure runId/category/prompt_id.json and trigger download.
 * Each JSON file has { turns, situation_log } — situation_log only at end (from last turn), not repeated per turn.
 * downloadFilename: optional (e.g. run001_spiral_tropes_sc01.zip) for checkpoint saves.
 */
export const downloadRunAsZip = async ({ runId, scenarios, downloadFilename }) => {
  const zip = new JSZip()
  const runFolder = zip.folder(runId)
  const categoryFolders = {}
  for (const [key, data] of Object.entries(scenarios)) {
    const [category, promptId] = key.split('/')
    const catFolder = categoryFolders[category] ?? runFolder.folder(category)
    categoryFolders[category] = catFolder
    const turns = Array.isArray(data) ? data : data.turns
    const metadata = Array.isArray(data) ? { category, prompt_id: promptId } : data.metadata
    const payload = scenarioPayloadForZip(turns, metadata)
    catFolder.file(`${promptId}.json`, JSON.stringify(payload, null, 2))
  }
  const blob = await zip.generateAsync({ type: 'blob' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = downloadFilename ?? `${runId}.zip`
  a.click()
  URL.revokeObjectURL(a.href)
}

/**
 * Run 30 × numTurns simulated conversations (seeker vs evaluated model), store mental model per turn.
 * mentalModelType: 'person_perception' | 'support' | 'induct' | 'structured' | 'types_support'. Run count is per type.
 * useSeparateMentalModelResponse: when true and mentalModelType is inline (support/induct/structured/types_support), use two independent calls (mental model only, then response only).
 * runId: when not provided, uses nextRunId(mentalModelType).
 * downloadWhenDone: if true, triggers a ZIP when run completes; saveAfterEachConvo (default true) saves after each scenario with filename runId_category_promptId.zip.
 * onScenarioStart(runId, category, promptId, categoryInjection, extraInjection), onTurn(...) for live UI.
 * startScenarioIndex: 0-based index to start from. Returns { runId, scenarios }. Pass existingRun to resume; optional onProgress, saveCheckpoint.
 * getConvo: optional (category, promptId) => Promise<{ turns } | null> to load convos from disk (CLI); when set, used instead of loadConvoFromConvosToUse.
 * onAfterScenario: optional (runId, scenarios) => void; called after each scenario (CLI can write to disk).
 */
export const run_simulations = async ({
  mentalModelType = 'person_perception',
  useOldModel = false,
  useSeparateMentalModelResponse = false,
  usePrior = false,
  numTurns = 20,
  maxScenarios = null,
  startScenarioIndex = 0,
  runId: providedRunId,
  seed = 42,
  getConvo = null,
  onProgress,
  onScenarioStart,
  onTurn,
  onAfterScenario = null,
  existingRun = null,
  saveCheckpoint = null,
  downloadWhenDone = false,
  saveAfterEachConvo = true
} = {}) => {
  const runId = providedRunId ?? nextRunId(mentalModelType)
  const scenarios = existingRun?.scenarios ? { ...existingRun.scenarios } : {}

  let taskList = SCENARIOS.map((s, i) => ({
    ...s,
    firstPrompt: s.prompts[0],
    categoryInjection: CATEGORY_INJECTIONS[s.category] ?? '',
    extraInjection: INJECTION_BEHAVIORS[(seed + i) % INJECTION_BEHAVIORS.length]
  }))
  taskList = taskList.slice(startScenarioIndex)
  if (maxScenarios != null) taskList = taskList.slice(0, maxScenarios)

  for (let i = 0; i < taskList.length; i++) {
    const task = taskList[i]
    const key = `${task.category}/${task.prompt_id}`
    try {
    const existing = scenarios[key]
    let turns = Array.isArray(existing) ? [...existing] : (existing?.turns ? [...existing.turns] : [])
    const startTurn = turns.length

    const useInlineMentalModel = INLINE_MENTAL_MODEL_TYPES.includes(mentalModelType)
    const usePreExistingConvo = useInlineMentalModel && useSeparateMentalModelResponse

    let preExistingConvo = null
    if (usePreExistingConvo) {
      preExistingConvo = getConvo
        ? await getConvo(task.category, task.prompt_id)
        : await loadConvoFromConvosToUse(task.category, task.prompt_id)
      if (!preExistingConvo) {
        throw new Error(
          `No pre-existing convo for ${task.category}/${task.prompt_id}. ${getConvo ? 'Check convo folder.' : 'Add data/seperate_call/convos_to_use/${task.category}/${task.prompt_id}.json'}`
        )
      }
    }

    const numTurnsEffective = usePreExistingConvo
      ? Math.min(numTurns, preExistingConvo.turns.length)
      : numTurns
    if (startTurn >= numTurnsEffective) continue

    const globalScenarioNum = startScenarioIndex + i + 1
    const parts = [DEFAULT_SEEKER_PROMPT]
    if (task.categoryInjection) parts.push(task.categoryInjection)
    if (task.extraInjection) parts.push(task.extraInjection)
    const systemPrompt = parts.join('\n\n')
    if (onScenarioStart) onScenarioStart(runId, task.category, task.prompt_id, task.categoryInjection, task.extraInjection)

    let history = []
    let memory = { turn_index: [] }

    for (let t = startTurn; t < numTurnsEffective; t++) {
      const turnId = `t${String(t).padStart(3, '0')}`
      let userMessage
      let assistantMessage
      let mentalModel

      if (usePreExistingConvo) {
        const turnData = preExistingConvo.turns[t]
        userMessage = turnData?.userMessage ?? ''
        assistantMessage = turnData?.assistantMessage ?? ''
        const priorMentalModelsByTurn = usePrior ? turns.slice(0, t).map(tr => tr.mentalModel) : null
        console.log('[Eval] Separate mode (convos_to_use): one call (mental model only)', { mentalModelType, turn: t + 1 })
        const result = await withRetryOnRateLimit(() =>
          sendMessageMentalModelOnly(history, userMessage, mentalModelType, priorMentalModelsByTurn)
        )
        mentalModel = result.mentalModel
      } else {
        userMessage = t === 0
          ? task.firstPrompt
          : await withRetryOnRateLimit(() => generateSeekerMessage(systemPrompt, history))

        if (useInlineMentalModel) {
          const priorMentalModelsByTurn = usePrior ? turns.slice(0, t).map(tr => tr.mentalModel) : null
          if (useSeparateMentalModelResponse) {
            console.log('[Eval] Separate mode: two calls (mental model, then response)', { mentalModelType, turn: t + 1 })
            const result = await withRetryOnRateLimit(() =>
              sendMessageSeparateMentalModelAndResponse(history, userMessage, mentalModelType, priorMentalModelsByTurn)
            )
            mentalModel = result.mentalModel
            assistantMessage = result.response
          } else {
            console.log('[Eval] Single call: mental model + response', { mentalModelType, turn: t + 1 })
            const result = await withRetryOnRateLimit(() =>
              sendMessageWithInlineMentalModel(history, userMessage, mentalModelType, priorMentalModelsByTurn)
            )
            mentalModel = result.mentalModel
            assistantMessage = result.response
          }
        } else {
          mentalModel = await withRetryOnRateLimit(() =>
            useOldModel
              ? inferMentalModelOld(userMessage)
              : inferMentalModel(userMessage, turnId, memory, history)
          )
          if (!useOldModel && mentalModel?.memory) memory = mentalModel.memory
          assistantMessage = await withRetryOnRateLimit(() =>
            sendMessageToLLM(userMessage, history, { useOldModel, mentalModel })
          )
        }
      }

      console.log(`[Eval] ${runId} ${task.category}/${task.prompt_id} turn ${t + 1}/${numTurnsEffective}`, {
        mentalModel,
        response: assistantMessage
      })

      if (onTurn) onTurn(runId, task.category, task.prompt_id, t, userMessage, assistantMessage, mentalModel)

      turns.push({ turnIndex: t, userMessage, assistantMessage, mentalModel })
      history.push({ role: 'user', content: userMessage }, { role: 'assistant', content: assistantMessage })

      if (saveCheckpoint) saveCheckpoint(runId, task.category, task.prompt_id, turns)
      if (onProgress) onProgress(runId, task.category, task.prompt_id, t, numTurnsEffective, globalScenarioNum)
    }

    scenarios[key] = {
      turns,
      metadata: {
        category: task.category,
        prompt_id: task.prompt_id,
        categoryInjection: task.categoryInjection || null,
        extraInjection: task.extraInjection || null,
        api_model: getApiProvider(),
        use_prior: !!usePrior,
      }
    }

    if (onAfterScenario) onAfterScenario(runId, { ...scenarios })
    if ((downloadWhenDone || saveAfterEachConvo) && Object.keys(scenarios).length > 0 && !onAfterScenario) {
      await downloadRunAsZip({
        runId,
        scenarios: { ...scenarios },
        downloadFilename: `${runId}_${task.category}_${task.prompt_id}.zip`
      })
    }
    } catch (err) {
      if (isContentFilterError(err)) {
        console.warn(`[Eval] Skipping scenario ${task.category}/${task.prompt_id} due to content filter. Continuing.`, err.message)
        scenarios[key] = {
          turns: [],
          metadata: {
            category: task.category,
            prompt_id: task.prompt_id,
            categoryInjection: task.categoryInjection || null,
            extraInjection: task.extraInjection || null,
            api_model: getApiProvider(),
            use_prior: !!usePrior,
            content_filter_skipped: true,
            error: err?.message || String(err)
          }
        }
        if (onAfterScenario) onAfterScenario(runId, { ...scenarios })
        continue
      }
      throw err
    }
  }

  if (downloadWhenDone && !onAfterScenario && Object.keys(scenarios).length > 0) {
    await downloadRunAsZip({ runId, scenarios })
  }
  return { runId, scenarios }
}

/**
 * Generate 30 × numTurns conversations (seeker + response only, no mental model).
 * For use with --generate_convo; save to data/separate_call/convo_#/.
 * Returns { scenarios } where each value is { turns, metadata } (turns have userMessage, assistantMessage only).
 */
export const runGenerateConvos = async ({
  numTurns = 20,
  seed = 42,
  onProgress = null,
  onScenarioStart = null,
} = {}) => {
  requireCurrentProviderEnv()
  const scenarios = {}
  let taskList = SCENARIOS.map((s, i) => ({
    ...s,
    firstPrompt: s.prompts[0],
    categoryInjection: CATEGORY_INJECTIONS[s.category] ?? '',
    extraInjection: INJECTION_BEHAVIORS[(seed + i) % INJECTION_BEHAVIORS.length]
  }))

  for (let i = 0; i < taskList.length; i++) {
    const task = taskList[i]
    const key = `${task.category}/${task.prompt_id}`
    const parts = [DEFAULT_SEEKER_PROMPT]
    if (task.categoryInjection) parts.push(task.categoryInjection)
    if (task.extraInjection) parts.push(task.extraInjection)
    const systemPrompt = parts.join('\n\n')
    if (onScenarioStart) onScenarioStart(task.category, task.prompt_id)

    const turns = []
    let history = []

    for (let t = 0; t < numTurns; t++) {
      const userMessage = t === 0
        ? task.firstPrompt
        : await withRetryOnRateLimit(() => generateSeekerMessage(systemPrompt, history))
      const assistantMessage = await withRetryOnRateLimit(() => sendResponseOnly(history, userMessage))
      turns.push({ turnIndex: t, userMessage, assistantMessage })
      history.push({ role: 'user', content: userMessage }, { role: 'assistant', content: assistantMessage })
      if (onProgress) onProgress(task.category, task.prompt_id, t, numTurns, i + 1)
    }

    scenarios[key] = {
      turns,
      metadata: {
        category: task.category,
        prompt_id: task.prompt_id,
        categoryInjection: task.categoryInjection || null,
        extraInjection: task.extraInjection || null,
        api_model: getApiProvider(),
      }
    }
  }

  return { scenarios }
}

export default {
  setApiProvider,
  getApiProvider,
  sendMessageToLLM,
  sendMessageWithInlineMentalModel,
  sendMessageMentalModelOnly,
  sendResponseOnly,
  sendMessageSeparateMentalModelAndResponse,
  loadConvoFromConvosToUse,
  loadHumanDataJson,
  runHumanDataAnalysis,
  downloadHumanAnalysisAsZip,
  backfillEmptyMentalModelsForHumanResult,
  isEmptyMentalModel,
  runGenerateConvos,
  inferUncertainAssumptions,
  inferMentalModel,
  inferMentalModelOld,
  generateSeekerMessage,
  run_simulations,
  downloadRunAsZip,
  nextRunId,
}
