/**
 * Single-call mental model prompts: conversation + "User A now says" + model-specific
 * description + JSON schema + "Then write your actual reply under RESPONSE:".
 * Wording must stay exactly as specified.
 */

function buildHistoryBlock(historyStr) {
  return historyStr.trim() ? historyStr : '(no previous conversation)'
}

/**
 * Build full prompt for support / induct / structured / types_support.
 * historyStr: conversation so far (plain text).
 * newUserText: User A's current message.
 * modelType: 'support' | 'induct' | 'structured' | 'types_support'
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

const SUFFIX_TYPES_SUPPORT = `First, output your mental model of User A. Estimate structured beliefs about the extent to which User A is seeking different types of support:

1. **Emotional Support** - Seeking opportunities for confiding, sympathetic listening, or caring behaviors:
   - Confiding/listening: seeking empathetic understanding or wanting someone to listen to private feelings or problems
   - Affection: seeking expressions of love, care, or emotional closeness
   - Esteem support: seeking validation of self-worth, acceptance despite difficulties
   - Being there: seeking unconditional availability or presence
   - Comforting touch: seeking physical comfort or affection 

2. **Social Contact and Companionship** - Seeking positive social interaction:
   - Companionship: wanting to spend time with others, do activities together
   - Positive interaction: seeking to joke, talk about interests, engage in diversionary activities
   - Shared activities: wanting to do fun things with others

3. **Belonging Support** - Seeking connection to a group or community:
   - Social integration: wanting to feel part of a group with common interests
   - Group inclusion: seeking comfort, security, or identity through group membership
   - Sense of belonging: wanting to feel included and connected

4. **Information and Guidance Support** - Seeking knowledge, advice, or problem-solving help:
   - Advice/guidance: seeking solutions, feedback, or direction
   - Information: seeking facts, explanations, or understanding of situations
   - Cognitive guidance: seeking help in defining or coping with problems

5. **Tangible Support** - Seeking practical or instrumental assistance:
   - Material aid: seeking financial help, resources, or physical objects
   - Practical assistance: seeking help with tasks, chores, or concrete actions
   - Reliable alliance: seeking assurance that others will provide tangible help

Treat these as *probabilistic beliefs* that may co-exist. These dimensions are independent and do NOT need to sum to 1. Each score should be between 0 and 1.

Then output ONLY a valid JSON object in the following structure:
{
  "mental_model": {
    "support_seeking": {
      "emotional_support": {
        "score": 0.0,
        "explanation": ""
      },
      "social_companionship": {
        "score": 0.0,
        "explanation": ""
      },
      "belonging_support": {
        "score": 0.0,
        "explanation": ""
      },
      "information_guidance": {
        "score": 0.0,
        "explanation": ""
      },
      "tangible_support": {
        "score": 0.0,
        "explanation": ""
      }
    }
  }
}

Then, on a new line, write your actual reply to User A under the heading:

RESPONSE:`

const SUFFIX_BY_MODEL = {
  support: SUFFIX_SUPPORT,
  induct: SUFFIX_INDUCT,
  structured: SUFFIX_STRUCTURED,
  types_support: SUFFIX_TYPES_SUPPORT,
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

export const INLINE_MENTAL_MODEL_TYPES = ['support', 'induct', 'structured', 'types_support']
