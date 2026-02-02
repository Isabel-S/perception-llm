// API service for Azure OpenAI integration
// All config from env: VITE_AZURE_ENDPOINT, VITE_AZURE_API_KEY, VITE_AZURE_DEPLOYMENT, VITE_AZURE_API_VERSION

const AZURE_ENDPOINT = import.meta.env.VITE_AZURE_ENDPOINT ?? ''
const AZURE_API_KEY = import.meta.env.VITE_AZURE_API_KEY ?? ''
const AZURE_DEPLOYMENT = import.meta.env.VITE_AZURE_DEPLOYMENT ?? ''
const AZURE_API_VERSION = import.meta.env.VITE_AZURE_API_VERSION ?? ''

const REQUIRED_ENV = ['VITE_AZURE_ENDPOINT', 'VITE_AZURE_API_KEY', 'VITE_AZURE_DEPLOYMENT', 'VITE_AZURE_API_VERSION']
function requireAzureEnv() {
  if (!AZURE_ENDPOINT || !AZURE_API_KEY || !AZURE_DEPLOYMENT || !AZURE_API_VERSION) {
    throw new Error(
      `Azure OpenAI config missing. Set in .env: ${REQUIRED_ENV.join(', ')}`
    )
  }
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

export const sendMessageToLLM = async (message, conversationHistory = []) => {
  requireAzureEnv()

  // Build the API URL
  const apiUrl = `${AZURE_ENDPOINT}openai/deployments/${AZURE_DEPLOYMENT}/chat/completions?api-version=${AZURE_API_VERSION}`

  // Convert conversation history to Azure format
  const messages = [
    {
      role: 'system',
      content: 'You are a helpful assistant.',
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

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': AZURE_API_KEY,
      },
      body: JSON.stringify({
        messages: messages,
        max_completion_tokens: 16384,
        model: AZURE_DEPLOYMENT
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

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': AZURE_API_KEY,
      },
      body: JSON.stringify({
        messages: messages,
        max_completion_tokens: 16384,
        model: AZURE_DEPLOYMENT
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

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': AZURE_API_KEY,
      },
      body: JSON.stringify({
        messages: messages,
        max_completion_tokens: 16384,
        model: AZURE_DEPLOYMENT
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

// NEW MENTAL MODEL (TurnState + Person Perception)
export const inferMentalModel = async (userMessage, turnId, memory = { turn_index: [], situation_log: {} }) => {
  requireAzureEnv()

  const safeText = String(userMessage)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');

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

  // Build memory text: full previous situation_log + turn_index so the model can take it in and return an updated version
  const memoryText = (() => {
    const log = memory.situation_log
    const idx = memory.turn_index || []
    const parts = []
    parts.push("Previous situation_log (take this in as a whole; return your updated version in memory):")
    parts.push("summary: " + (log?.summary || "(none)"))
    parts.push("facts: " + (log?.facts?.length ? JSON.stringify(log.facts) : "[]"))
    if (idx.length) {
      parts.push("turn_index: " + idx.map(t => `${t.turn_id}: ${typeof t.person_perception === 'string' ? t.person_perception : (t.notes ?? JSON.stringify(t.person_perception ?? ''))}`).join(" | "))
    }
    return parts.join("\n")
  })()

  // System message
  const systemMsg = (
    "You analyze a user message and infer person perception + memory. " +
    "Output STRICT JSON ONLY (no markdown, no comments, no extra keys). " +
    "Do not output any text before or after the JSON. Do not wrap in code fences."
  )

  const userMsg = `User message (turn ${turnId}):
${userMessage}

Previous memory:
${memoryText}

Return STRICT JSON only (no markdown, no comments, no extra keys).
Do not output any text before or after the JSON. Do not wrap in code fences.

Required output JSON (copy this structure exactly and fill fields):

{
  "person_perception": {
    "behavior": {
      "turn_id": "${turnId}",
      "text": "${safeText}",
      "observations": [
        {
          "observed_evidence": "",
          "diagnosticity": {
            "situational_force": 0.0,
            "consistency": 0.0
          }
        }
      ]
    },

    "mental_state": {
      "mind3d": {
        "rationality": 0.0,
        "valence": 0.0,
        "social_impact": 0.0
      },
      "immediate_intent": { "label": "", "confidence": 0.0 },
      "horizontal_warmth": 0.0,
      "vertical_competence": 0.0,
      "role_hypothesis": { "label": "", "confidence": 0.0 },
      "user_model_of_llm": { "label": "", "confidence": 0.0 }
    },

    "motives_goals": {
      "inferred_motives": [
        { "label": "", "confidence": 0.0 }
      ],
      "goal": { "label": "", "confidence": 0.0 }
    },

    "long_term": {
      "items": [
        {
          "label": "",
          "type": "preference",
          "status": "candidate",
          "confidence": 0.0,
          "evidence_turn_ids": []
        }
      ]
    }
  },

  "memory": {
    "situation_log": {
      "summary": "",
      "facts": [
        { "fact": "", "turn_id": "${turnId}" }
      ]
    },
    "turn_index": [
      { "turn_id": "${turnId}", "person_perception": {
            "anyOf": [
              { "type": "string" },
              { "type": "object" }
            ]
          }
       }
    ]
  }
}

FILLING INSTRUCTIONS (NOT part of output; output must end after the final "}"):

1) behavior.observations (1+ items per turn)
- observed_evidence: short description of what was observed (surface cues, context)
- diagnosticity:
  - situational_force [0,1]: how much the situation explains behavior (higher = less person-diagnostic), think about if anyone would do it in this situation.
  - consistency [0,1]: whether the behavior is consistent (e.g. repeated from memory/pattern_counts) (first time should be 0.0)

2) mental_state (turn-level; do NOT treat as traits)
- mind3d: low-dimensional psychological representation of mental states [-1, 1]
  - rationality: reacting/feeling (towards -1) vs thinking/planning (towards 1)
  - valence: negative (towards -1) vs positive (towards 1)
  - social_impact: how impactful is the state in the social world? hesitant/uncertain/low-intensity (towards -1) vs forceful/directive/high-intensity (towards 1)
- immediate_intent: usually an interaction goal, think about what is the communicated goal of the user? what are they trying to acheive right now? fill as a short label.
- horizontal_warmth [0,1]: cooperative stance toward the exchange, whether the user is likely to be competitive/harmful (towards 0) or cooperative/helpful (towards 1)
- vertical_competence [0,1]: ability to act on intent (clarity/consistency), and theri capability/agency to execute/comunicate those intentions.
- role_hypothesis: what you think your role should be, often derived from the users intent, motives, goals
- user_model_of_llm: what you think the user views you as


3) motives_goals: inferred from curernt message and conversation history, usually across a few or multiple turns
- inferred_motives: 1–3 hypotheses for why intent matters
- goal: best guess of what success looks like across the session, what the user is aiming for

4) long_term.items (candidates AND traits): a persistent, cross-turn rolling list of long-term hypotheses inferred only from repeated observed behavior and motives/goals. These can be updated or promoted to traits based on the evidence across turns.
- status: candidate by default; promote to trait only with repeated evidence across turns and not fully situationally forced
- type: preference|tendency|other (choose ONE of these literal strings)
- keep list short (0–5). Do not invent items.

5) memory
You receive the full previous situation_log (summary + facts) under "Previous memory". Return your updated situation_log: take those in as a whole and output whatever you see fit (same, or add/remove/rephrase/collate facts; update summary).
- situation_log.summary: 1 sentence rolling summary
- situation_log.facts: the updated list of explicit user-provided facts (you may add, remove, rephrase, or collate; this list is the source of truth we keep).
- turn_index[].person_perception: object | "" (optional)—either the full person_perception object (behavior, situation, mental_state, motives_goals, long_term) for that turn, or a short notes string. Prefer full JSON for the current turn and optionally the previous turn; use "" or a notes string only for older turns.
`

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

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': AZURE_API_KEY,
      },
      body: JSON.stringify({
        messages: messages,
        max_completion_tokens: 16384,
        model: AZURE_DEPLOYMENT
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
    console.error('Failed to parse mental-model JSON, using defaults:', error)
    const fallback = JSON.parse(JSON.stringify(DEFAULT_MM))
    fallback.behavior.turn_id = turnId
    fallback.behavior.text = userMessage
    return fallback
  }
}

export default {
  sendMessageToLLM,
  inferUncertainAssumptions,
  inferMentalModel,
  inferMentalModelOld,
}
