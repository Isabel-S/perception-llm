/**
 * Single-call mental model prompts: conversation + "User A now says" + model-specific
 * description + JSON schema + "Then write your actual reply under RESPONSE:".
 * Wording must stay exactly as specified.
 */

function buildHistoryBlock(historyStr) {
  return historyStr.trim() ? historyStr : '(no previous conversation)'
}

/**
 * Build full prompt for support / induct / structured.
 * historyStr: conversation so far (plain text).
 * newUserText: User A's current message.
 * modelType: 'support' | 'induct' | 'structured'
 */
export function buildPromptWithHistory(historyStr, newUserText, modelType) {
  const historyBlock = buildHistoryBlock(historyStr)
  const base = `You are an AI assistant having a conversation with a human (User A).

Conversation so far:
"""${historyBlock}"""

User A now says:
"""${newUserText}"""
`
  const suffix = SUFFIX_BY_MODEL[modelType]
  if (!suffix) throw new Error(`Unknown mental model type: ${modelType}`)
  return base + suffix
}

const SUFFIX_SUPPORT = `First, output your mental model of User A. Estimate structured beliefs about the extent to which User A is seeking different types of support, following Cutrona (1992)'s taxonomy:

- Informational support: seeking facts, explanations, advice, suggestions, or an objective appraisal of the situation (e.g., what is true, what to do, or how to evaluate options), independent of emotional reassurance.

- Esteem / validation support: seeking affirmation of the self or of one's perspective, including validation of feelings, confirmation that one's interpretation is reasonable, or relief from blame, guilt, or self-doubt.

- Emotional support: seeking expressions of empathy, care, sympathy, or understanding, including acknowledgment of emotional difficulty or encouragement in response to distress.

Treat these as *probabilistic beliefs* that may co-exist. These dimensions are independent and do NOT need to sum to 1. Each score should be between 0 and 1.

Then output ONLY a valid JSON object in the following structure:

{
  "mental_model": {
    "support_seeking": {
      "informational": {
        "score": 0.0,
        "explanation": ""
      },
      "validation_esteem": {
        "score": 0.0,
        "explanation": ""
      },
      "emotional": {
        "score": 0.0,
        "explanation": ""
      }
    }
  }
}

Then, on a new line, write your actual reply to User A under the heading:

RESPONSE:
`

const SUFFIX_INDUCT = `First, output your mental model of User A. Estimate structured beliefs about User A along the following dimensions:

1. Belief about how much User A is seeking validation/support.
2. Belief about how right User A is in the situation.
3. Belief about whether User A has more information than you (the model).
4. Belief about whether User A is seeking an objective perspective.
Then output ONLY a valid JSON object in the following structure:

{
  "mental_model": {
    "beliefs": {
      "validation_seeking": {
        "score": 0.0,
        "explanation": ""
      },
      "user_rightness": {
        "score": 0.0,
        "explanation": ""
      },
      "user_information_advantage": {
        "score": 0.0,
        "explanation": ""
      },
      "objectivity_seeking": {
        "score": 0.0,
        "explanation": ""
      },
    }
  }
}

Then, on a new line, write your actual reply to User A under the heading:

RESPONSE:
`

const SUFFIX_STRUCTURED = `First, infer your top three possible mental models of User A (the human). 
Then output them only in valid JSON format with the following structure:

{
  "mental_models": [
    {
      "model_name": "",
      "description": "",
      "probability": 0.0
    },
    {
      "model_name": "",
      "description": "",
      "probability": 0.0
    },
    {
      "model_name": "",
      "description": "",
      "probability": 0.0
    }
  ]
}

Each probability must be a number between 0 and 1 that sums to 1 across the three models.

Then, on a new line, write your actual reply to User A under the heading:

RESPONSE:`

const SUFFIX_BY_MODEL = {
  support: SUFFIX_SUPPORT,
  induct: SUFFIX_INDUCT,
  structured: SUFFIX_STRUCTURED,
}

/** Strip markdown code fences from JSON string if present */
function stripJsonFences(text) {
  let s = text.trim()
  if (s.startsWith('```json')) s = s.replace(/^```json\s*/, '').replace(/\s*```$/, '')
  else if (s.startsWith('```')) s = s.replace(/^```\s*/, '').replace(/\s*```$/, '')
  return s
}

/**
 * Parse single-call API response: first JSON object (mental model), then text after "RESPONSE:".
 * Returns { mentalModel, response } where mentalModel is the parsed JSON (or raw object for structured's mental_models).
 */
export function parseSingleCallResponse(content) {
  const raw = (content || '').trim()
  const responseMarker = /RESPONSE:\s*/i
  const idx = raw.search(responseMarker)
  let jsonPart = raw
  let responseText = ''
  if (idx >= 0) {
    jsonPart = raw.slice(0, idx).trim()
    responseText = raw.slice(idx).replace(responseMarker, '').trim()
  }

  // Find first complete JSON object (allow { ... } or root "mental_model" / "mental_models")
  let mentalModel = null
  const open = jsonPart.indexOf('{')
  if (open >= 0) {
    let depth = 0
    let end = -1
    for (let i = open; i < jsonPart.length; i++) {
      if (jsonPart[i] === '{') depth++
      else if (jsonPart[i] === '}') {
        depth--
        if (depth === 0) {
          end = i + 1
          break
        }
      }
    }
    if (end > open) {
      try {
        const str = stripJsonFences(jsonPart.slice(open, end))
        mentalModel = JSON.parse(str)
      } catch (_) {
        mentalModel = null
      }
    }
  }

  return { mentalModel: mentalModel || {}, response: responseText }
}

export const INLINE_MENTAL_MODEL_TYPES = ['support', 'induct', 'structured']
