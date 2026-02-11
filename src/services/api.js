// API service for Azure OpenAI integration
// All config from env: VITE_AZURE_ENDPOINT, VITE_AZURE_API_KEY, VITE_AZURE_DEPLOYMENT, VITE_AZURE_API_VERSION

import JSZip from 'jszip'
import { DEFAULT_SEEKER_PROMPT } from '../eval/default_prompt.js'
import { CATEGORY_INJECTIONS } from '../eval/categories.js'
import { INJECTION_BEHAVIORS } from '../eval/injections.js'
import { SCENARIOS } from '../eval/scenarios.js'
import { buildPromptWithHistory, parseSingleCallResponse, INLINE_MENTAL_MODEL_TYPES } from '../eval/mental_model_prompts.js'

const AZURE_ENDPOINT = import.meta.env.VITE_AZURE_ENDPOINT ?? ''
const AZURE_API_KEY = import.meta.env.VITE_AZURE_API_KEY ?? ''
const AZURE_DEPLOYMENT = import.meta.env.VITE_AZURE_DEPLOYMENT ?? ''
const AZURE_API_VERSION = import.meta.env.VITE_AZURE_API_VERSION ?? ''

// Generation defaults
const DEFAULT_MAX_COMPLETION_TOKENS = 5000
const DEFAULT_TEMPERATURE = 0.7
const DEFAULT_TOP_P = 0.9

const REQUIRED_ENV = ['VITE_AZURE_ENDPOINT', 'VITE_AZURE_API_KEY', 'VITE_AZURE_DEPLOYMENT', 'VITE_AZURE_API_VERSION']
function requireAzureEnv() {
  if (!AZURE_ENDPOINT || !AZURE_API_KEY || !AZURE_DEPLOYMENT || !AZURE_API_VERSION) {
    throw new Error(
      `Azure OpenAI config missing. Set in .env: ${REQUIRED_ENV.join(', ')}`
    )
  }
}

const RATE_LIMIT_MAX_RETRIES = 5
const DELAY_BETWEEN_CALLS_MS = 2000
const REQUEST_TIMEOUT_MS = 120000

function isRateLimitError(err) {
  const msg = (err?.message || '').toLowerCase()
  return msg.includes('rate limit') || msg.includes('exceeded') || msg.includes('429')
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

function parseRetryAfterSeconds(err) {
  const match = (err?.message || '').match(/retry after (\d+) seconds/i)
  return match ? Math.max(parseInt(match[1], 10), 8) : null
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
        const sec = isRateLimitError(err) ? (parseRetryAfterSeconds(err) ?? 8) : 10
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
  requireAzureEnv()

  // Build the API URL
  const apiUrl = `${AZURE_ENDPOINT}openai/deployments/${AZURE_DEPLOYMENT}/chat/completions?api-version=${AZURE_API_VERSION}`

  const { useOldModel = false, mentalModel = null } = context
  const preamble = buildMentalModelPreamble(useOldModel, mentalModel)
  const systemContent = preamble
    ? preamble + '\n\nRespond to the user. Use the mental model above to shape your tone and structure; do not restate it explicitly.'
    : 'You are a helpful assistant.'

  // Convert conversation history to Azure format
  const messages = [
    {
      role: 'system',
      content: systemContent,
    },
    ...conversationHistory.map(msg => ({
      role: msg.role,
      content: msg.content
    })),
    {
      role: 'user',
      content: message
    }
  ]

  console.log('[API sendMessageToLLM] system:', systemContent)
  console.log('[API sendMessageToLLM] messages (full):', messages)

  try {
    const response = await fetchWithTimeout(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': AZURE_API_KEY,
      },
      body: JSON.stringify({
        messages: messages,
        max_completion_tokens: DEFAULT_MAX_COMPLETION_TOKENS,
        temperature: DEFAULT_TEMPERATURE,
        top_p: DEFAULT_TOP_P,
        model: AZURE_DEPLOYMENT,
      }),
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      throw new Error(
        errorData.error?.message || 
        `API request failed with status ${response.status}`
      )
    }

    const data = await response.json()
    return data.choices[0].message.content
  } catch (error) {
    console.error('Azure OpenAI API error:', error)
    throw error
  }
}

export const inferUncertainAssumptions = async (conversationHistory = []) => {
  requireAzureEnv()

  // Ensure we have conversation content
  if (!conversationHistory || conversationHistory.length === 0) {
    return { assumptions: [] }
  }

  // Build the API URL
  const apiUrl = `${AZURE_ENDPOINT}openai/deployments/${AZURE_DEPLOYMENT}/chat/completions?api-version=${AZURE_API_VERSION}`

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
    {
      role: 'system',
      content: systemMsg
    },
    {
      role: 'user',
      content: userMsg
    }
  ]

  console.log('[API inferUncertainAssumptions] system:', systemMsg)
  console.log('[API inferUncertainAssumptions] user:', userMsg)

  try {
    const response = await fetchWithTimeout(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': AZURE_API_KEY,
      },
      body: JSON.stringify({
        messages: messages,
        max_completion_tokens: DEFAULT_MAX_COMPLETION_TOKENS,
        model: AZURE_DEPLOYMENT,
      }),
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      throw new Error(
        errorData.error?.message || 
        `API request failed with status ${response.status}`
      )
    }

    const data = await response.json()
    const responseText = data.choices[0].message.content

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
  requireAzureEnv()

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

  // Build the API URL
  const apiUrl = `${AZURE_ENDPOINT}openai/deployments/${AZURE_DEPLOYMENT}/chat/completions?api-version=${AZURE_API_VERSION}`

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
    const response = await fetchWithTimeout(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': AZURE_API_KEY,
      },
      body: JSON.stringify({
        messages: messages,
        max_completion_tokens: DEFAULT_MAX_COMPLETION_TOKENS,
        model: AZURE_DEPLOYMENT,
      }),
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      throw new Error(
        errorData.error?.message || 
        `API request failed with status ${response.status}`
      )
    }

    const data = await response.json()
    const responseText = data.choices[0].message.content

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
  requireAzureEnv()

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

  // Build the API URL
  const apiUrl = `${AZURE_ENDPOINT}openai/deployments/${AZURE_DEPLOYMENT}/chat/completions?api-version=${AZURE_API_VERSION}`

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
    const response = await fetchWithTimeout(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': AZURE_API_KEY,
      },
      body: JSON.stringify({
        messages: messages,
        max_completion_tokens: DEFAULT_MAX_COMPLETION_TOKENS,
        model: AZURE_DEPLOYMENT,
      }),
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      throw new Error(
        errorData.error?.message || 
        `API request failed with status ${response.status}`
      )
    }

    const data = await response.json()
    const jsonText = stripJsonFences(data.choices[0].message.content)
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

/**
 * Single-call flow for support / induct / structured: one prompt with conversation + User A says + mental model instructions + JSON + RESPONSE.
 * Returns { mentalModel, response }.
 */
export const sendMessageWithInlineMentalModel = async (conversationHistory, newUserText, modelType) => {
  requireAzureEnv()
  const apiUrl = `${AZURE_ENDPOINT}openai/deployments/${AZURE_DEPLOYMENT}/chat/completions?api-version=${AZURE_API_VERSION}`

  const historyStr = conversationHistory.length
    ? conversationHistory.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n\n')
    : ''
  const prompt = buildPromptWithHistory(historyStr, newUserText, modelType)

  const messages = [
    { role: 'user', content: prompt }
  ]

  const response = await fetchWithTimeout(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': AZURE_API_KEY },
    body: JSON.stringify({
      messages,
      max_completion_tokens: DEFAULT_MAX_COMPLETION_TOKENS,
      temperature: DEFAULT_TEMPERATURE,
      top_p: DEFAULT_TOP_P,
      model: AZURE_DEPLOYMENT,
    }),
  })

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}))
    throw new Error(errorData.error?.message || `API request failed with status ${response.status}`)
  }

  const data = await response.json()
  const content = data.choices?.[0]?.message?.content ?? ''
  return parseSingleCallResponse(content)
}

// --- Eval: simulated conversations ---

/** Generate next seeker (user) message given system prompt and conversation history. */
export const generateSeekerMessage = async (systemPrompt, conversationHistory) => {
  requireAzureEnv()
  const apiUrl = `${AZURE_ENDPOINT}openai/deployments/${AZURE_DEPLOYMENT}/chat/completions?api-version=${AZURE_API_VERSION}`
  const messages = [
    { role: 'system', content: systemPrompt },
    ...conversationHistory.map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: 'Generate the next message the seeker would say. Output only that message, nothing else. No quotes or labels.' }
  ]
  console.log('[API generateSeekerMessage] system:', systemPrompt)
  console.log('[API generateSeekerMessage] messages (full):', messages)
  const response = await fetchWithTimeout(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': AZURE_API_KEY },
    body: JSON.stringify({
      messages,
      max_completion_tokens: DEFAULT_MAX_COMPLETION_TOKENS,
      temperature: DEFAULT_TEMPERATURE,
      top_p: DEFAULT_TOP_P,
      model: AZURE_DEPLOYMENT,
    })
  })
  if (!response.ok) throw new Error(`Seeker API failed: ${response.status}`)
  const data = await response.json()
  return (data.choices?.[0]?.message?.content ?? '').trim()
}

const EVAL_RUN_COUNT_KEY = 'perception_llm_eval_run_count'

/** Next run id from a persisted count per mental model type: run001, run002, ... */
function nextRunId(mentalModelType = 'person_perception') {
  const key = `${EVAL_RUN_COUNT_KEY}_${mentalModelType}`
  try {
    const n = parseInt(localStorage.getItem(key) || '0', 10) + 1
    localStorage.setItem(key, String(n))
    return `run${String(n).padStart(3, '0')}`
  } catch {
    return `run${String(Date.now()).slice(-6)}`
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
 * mentalModelType: 'person_perception' | 'old_model' | 'support' | 'induct' | 'structured'. Run count is per type.
 * useOldModel: when mentalModelType is person_perception (false) or old_model (true); ignored for support/induct/structured.
 * runId: when not provided, uses nextRunId(mentalModelType).
 * downloadWhenDone: if true, triggers a ZIP when run completes; saveAfterEachConvo (default true) saves after each scenario with filename runId_category_promptId.zip.
 * onScenarioStart(runId, category, promptId, categoryInjection, extraInjection), onTurn(...) for live UI.
 * startScenarioIndex: 0-based index to start from. Returns { runId, scenarios }. Pass existingRun to resume; optional onProgress, saveCheckpoint.
 */
export const run_simulations = async ({
  mentalModelType = 'person_perception',
  useOldModel = false,
  numTurns = 20,
  maxScenarios = null,
  startScenarioIndex = 0,
  runId: providedRunId,
  seed = 42,
  onProgress,
  onScenarioStart,
  onTurn,
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
    const existing = scenarios[key]
    let turns = Array.isArray(existing) ? [...existing] : (existing?.turns ? [...existing.turns] : [])
    const startTurn = turns.length
    if (startTurn >= numTurns) continue

    const globalScenarioNum = startScenarioIndex + i + 1
    const parts = [DEFAULT_SEEKER_PROMPT]
    if (task.categoryInjection) parts.push(task.categoryInjection)
    if (task.extraInjection) parts.push(task.extraInjection)
    const systemPrompt = parts.join('\n\n')
    if (onScenarioStart) onScenarioStart(runId, task.category, task.prompt_id, task.categoryInjection, task.extraInjection)

    let history = []
    let memory = { turn_index: [] }

    const useInlineMentalModel = INLINE_MENTAL_MODEL_TYPES.includes(mentalModelType)

    for (let t = startTurn; t < numTurns; t++) {
      const userMessage = t === 0
        ? task.firstPrompt
        : await withRetryOnRateLimit(() => generateSeekerMessage(systemPrompt, history))
      const turnId = `t${String(t).padStart(3, '0')}`

      let mentalModel
      let assistantMessage

      if (useInlineMentalModel) {
        const result = await withRetryOnRateLimit(() =>
          sendMessageWithInlineMentalModel(history, userMessage, mentalModelType)
        )
        mentalModel = result.mentalModel
        assistantMessage = result.response
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

      console.log(`[Eval] ${runId} ${task.category}/${task.prompt_id} turn ${t + 1}/${numTurns}`, {
        mentalModel,
        response: assistantMessage
      })

      if (onTurn) onTurn(runId, task.category, task.prompt_id, t, userMessage, assistantMessage, mentalModel)

      turns.push({ turnIndex: t, userMessage, assistantMessage, mentalModel })
      history.push({ role: 'user', content: userMessage }, { role: 'assistant', content: assistantMessage })

      if (saveCheckpoint) saveCheckpoint(runId, task.category, task.prompt_id, turns)
      if (onProgress) onProgress(runId, task.category, task.prompt_id, t, numTurns, globalScenarioNum)
    }

    scenarios[key] = {
      turns,
      metadata: {
        category: task.category,
        prompt_id: task.prompt_id,
        categoryInjection: task.categoryInjection || null,
        extraInjection: task.extraInjection || null,
      }
    }

    if ((downloadWhenDone || saveAfterEachConvo) && Object.keys(scenarios).length > 0) {
      await downloadRunAsZip({
        runId,
        scenarios: { ...scenarios },
        downloadFilename: `${runId}_${task.category}_${task.prompt_id}.zip`
      })
    }
  }

  if (downloadWhenDone && Object.keys(scenarios).length > 0) {
    await downloadRunAsZip({ runId, scenarios })
  }
  return { runId, scenarios }
}

export default {
  sendMessageToLLM,
  sendMessageWithInlineMentalModel,
  inferUncertainAssumptions,
  inferMentalModel,
  inferMentalModelOld,
  generateSeekerMessage,
  run_simulations,
  downloadRunAsZip,
}
