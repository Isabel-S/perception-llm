import json
from datetime import datetime
import streamlit as st
from openai import OpenAI

st.set_page_config(page_title="Mental Model Chat", layout="wide")
st.title("Mental Model Chat Demo")

st.write(
    "Mental model is inferred by an LLM until you explicitly change any control (then it locks).\n"
    "Additionally, each turn we infer *uncertain assumptions* about the user/situation with probabilities "
    "and show them in a sidebar panel (JSON). All turns are logged."
)

# ---------------- Session state ----------------

DEFAULT_MM = {
    # Epistemic
    "user_certainty": 0.5,
    "model_seen_as_expert": 0.8,
    "expects_correction": True,
    # Relational / goals
    "validation_seeking": 0.5,
    "objectivity_seeking": 0.5,
    "empathy_expectation": 0.5,
    # Style
    "directness": 0.5,
    "informativeness": 0.7,
    # Role
    "assistant_role": "Neutral assistant",
}

if "messages" not in st.session_state:
    st.session_state.messages = []  # [{"role": "user"/"assistant", "content": str}]

if "mm_values" not in st.session_state:
    st.session_state.mm_values = DEFAULT_MM.copy()

if "turn_index" not in st.session_state:
    st.session_state.turn_index = 0  # completed assistant turns

if "turn_logs" not in st.session_state:
    st.session_state.turn_logs = []

if "mm_locked" not in st.session_state:
    st.session_state.mm_locked = False

# NEW: latest assumptions JSON + history
if "assumptions_latest" not in st.session_state:
    st.session_state.assumptions_latest = None  # dict or None
if "assumptions_history" not in st.session_state:
    st.session_state.assumptions_history = []  # list of dicts (per turn)


# ---------------- LLM calls ----------------

def infer_mental_model_with_llm(text: str, api_key: str, model_name: str) -> dict:
    client = OpenAI(api_key=api_key)

    system_msg = (
        "You analyze a single user message and infer the user's conversational expectations. "
        "Output STRICT JSON ONLY (no markdown, no comments)."
    )
    user_msg = f"""
User message:
{text}

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

Output STRICT JSON only.
"""

    try:
        resp = client.responses.create(
            model=model_name,
            input=[
                {"role": "system", "content": system_msg},
                {"role": "user", "content": user_msg},
            ],
        )
        mm = json.loads(resp.output_text)
        cleaned = DEFAULT_MM.copy()
        for k in cleaned:
            if k in mm:
                cleaned[k] = mm[k]
        return cleaned
    except Exception as e:
        st.warning(f"Failed to parse mental-model JSON, using defaults. Error: {e}")
        return DEFAULT_MM.copy()


def infer_uncertain_assumptions_with_llm(
    conversation_text: str,
    api_key: str,
    model_name: str,
) -> dict:
    """
    Returns a dict like:
    {"assumptions":[{"assumption":"...", "probability":0.73, "evidence":"..."}, ...]}
    evidence is optional; you can remove it if you want.
    """
    client = OpenAI(api_key=api_key)

    system_msg = (
        "Before answering, pause and reconsider assumptions. "
        "Output uncertain assumptions about the user and their situation, with probabilities, "
        "in JSON format ONLY. Do not include any additional text."
    )

    user_msg = f"""
Conversation so far (most recent at bottom):
{conversation_text}

Return STRICT JSON with this schema:

{{
  "assumptions": [
    {{
      "assumption": "string",
      "probability": 0.0,
      "evidence": "string (brief quote/paraphrase cue from the conversation, optional)"
    }}
  ]
}}

Rules:
- Provide 3 to 8 assumptions.
- Probabilities must be between 0 and 1.
- Assumptions should be *uncertain* (not obvious facts).
- Keep assumptions specific and conversationally relevant.
- Output JSON only.
"""

    try:
        resp = client.responses.create(
            model=model_name,
            input=[
                {"role": "system", "content": system_msg},
                {"role": "user", "content": user_msg},
            ],
        )
        data = json.loads(resp.output_text)

        # Light validation/sanitization
        if not isinstance(data, dict) or "assumptions" not in data or not isinstance(data["assumptions"], list):
            raise ValueError("Assumptions JSON did not match expected shape.")

        cleaned = []
        for item in data["assumptions"][:10]:
            if not isinstance(item, dict) or "assumption" not in item or "probability" not in item:
                continue
            prob = float(item["probability"])
            prob = max(0.0, min(1.0, prob))
            cleaned.append({
                "assumption": str(item["assumption"]),
                "probability": prob,
                "evidence": str(item.get("evidence", "")),
            })

        return {"assumptions": cleaned}
    except Exception as e:
        st.warning(f"Failed to parse assumptions JSON. Error: {e}")
        return {"assumptions": []}


# ---------------- Sidebar: mental model controls ----------------

st.sidebar.header("Mental model controls")

first_turn = (st.session_state.turn_index == 0)
mm = st.session_state.mm_values
mm_locked = st.session_state.mm_locked
disabled = first_turn  # disable controls before any assistant turn exists

if first_turn:
    st.sidebar.info("First message: mental model will be inferred. Controls unlock right after the first reply.")
elif not mm_locked:
    st.sidebar.info("Mental model is UNLOCKED: it will be re-inferred each user turn until you change any control.")
else:
    st.sidebar.info("Mental model is LOCKED: your settings are now the ground truth.")

# Epistemic
user_certainty = st.sidebar.slider("User's own certainty about being right", 0.0, 1.0, float(mm["user_certainty"]), 0.1, disabled=disabled)
model_seen_as_expert = st.sidebar.slider("User thinks the model knows more", 0.0, 1.0, float(mm["model_seen_as_expert"]), 0.1, disabled=disabled)
expects_correction = st.sidebar.checkbox("User expects explicit correction if wrong", value=bool(mm["expects_correction"]), disabled=disabled)

# Relational
validation_seeking = st.sidebar.slider("Desire for validation/affirmation", 0.0, 1.0, float(mm["validation_seeking"]), 0.1, disabled=disabled)
objectivity_seeking = st.sidebar.slider("Desire for objective, possibly disagreeing perspective", 0.0, 1.0, float(mm["objectivity_seeking"]), 0.1, disabled=disabled)
empathy_expectation = st.sidebar.slider("Empathy / emotional support", 0.0, 1.0, float(mm["empathy_expectation"]), 0.1, disabled=disabled)

# Style
directness = st.sidebar.slider("Directness / bluntness", 0.0, 1.0, float(mm["directness"]), 0.1, disabled=disabled)
informativeness = st.sidebar.slider("Informativeness / level of detail", 0.0, 1.0, float(mm["informativeness"]), 0.1, disabled=disabled)

assistant_role = st.sidebar.selectbox(
    "How the user treats the assistant",
    ["Neutral assistant", "Expert", "Friend/peer", "Therapist-like listener"],
    index=["Neutral assistant", "Expert", "Friend/peer", "Therapist-like listener"].index(mm["assistant_role"]),
    disabled=disabled,
)

# Lock mental model upon first explicit user change
if not first_turn and not mm_locked:
    current_from_controls = {
        "user_certainty": float(user_certainty),
        "model_seen_as_expert": float(model_seen_as_expert),
        "expects_correction": bool(expects_correction),
        "validation_seeking": float(validation_seeking),
        "objectivity_seeking": float(objectivity_seeking),
        "empathy_expectation": float(empathy_expectation),
        "directness": float(directness),
        "informativeness": float(informativeness),
        "assistant_role": assistant_role,
    }

    changed = False
    for k, v in current_from_controls.items():
        old = mm[k]
        if isinstance(old, (int, float)) and isinstance(v, (int, float)):
            if abs(float(v) - float(old)) > 1e-6:
                changed = True
                break
        else:
            if v != old:
                changed = True
                break

    if changed:
        st.session_state.mm_locked = True
        st.session_state.mm_values = current_from_controls
        mm_locked = True
        mm = current_from_controls


# ---------------- Sidebar: NEW assumptions panel ----------------

st.sidebar.markdown("---")
st.sidebar.subheader("Inferred assumptions (JSON)")

with st.sidebar.expander("Show assumptions inferred last turn", expanded=True):
    if st.session_state.assumptions_latest is None:
        st.caption("No assumptions inferred yet.")
    else:
        st.json(st.session_state.assumptions_latest, expanded=False)

# Optional: show assumptions history
with st.sidebar.expander("Assumptions history (per turn)", expanded=False):
    if not st.session_state.assumptions_history:
        st.caption("No history yet.")
    else:
        st.json(st.session_state.assumptions_history, expanded=False)


# ---------------- Sidebar: API + logging ----------------

st.sidebar.markdown("---")
st.sidebar.subheader("API configuration")
api_key = st.sidebar.text_input("OpenAI API key", type="password")
mm_model_name = st.sidebar.text_input("Mental-model model", value="gpt-5.1-mini")
assumptions_model_name = st.sidebar.text_input("Assumptions model", value="gpt-5.1-mini")
response_model_name = st.sidebar.text_input("Response model", value="gpt-5.1")

st.sidebar.markdown("---")
st.sidebar.subheader("Logging")

if st.session_state.turn_logs:
    with st.sidebar.expander("View raw logs"):
        st.json(st.session_state.turn_logs, expanded=False)
    st.sidebar.download_button(
        label="Download logs as JSON",
        data=json.dumps(st.session_state.turn_logs, indent=2),
        file_name="mental_model_logs.json",
        mime="application/json",
    )
else:
    st.sidebar.caption("No turns logged yet.")


# ---------------- Main chat display ----------------

for message in st.session_state.messages:
    with st.chat_message(message["role"]):
        st.markdown(message["content"])


# ---------------- Helpers ----------------

def build_history_text(messages):
    lines = []
    for m in messages:
        role = "User" if m["role"] == "user" else "Assistant"
        lines.append(f"{role}: {m['content']}")
    return "\n".join(lines)

def build_mental_model_preamble(mm_vals: dict) -> str:
    return f"""
You are an assistant responding to a user. Before answering, read this
description of the user's inferred conversational expectations and goals.
Use it to shape your tone and structure, but do NOT restate it explicitly.

[Epistemic stance]
- User certainty (0–1): {mm_vals['user_certainty']:.2f}
- User treats assistant as expert (0–1): {mm_vals['model_seen_as_expert']:.2f}
- Expects explicit correction: {mm_vals['expects_correction']}

[Relational goals]
- Validation seeking (0–1): {mm_vals['validation_seeking']:.2f}
- Objectivity seeking (0–1): {mm_vals['objectivity_seeking']:.2f}
- Empathy expectation (0–1): {mm_vals['empathy_expectation']:.2f}

[Style]
- Directness (0–1): {mm_vals['directness']:.2f}
- Informativeness (0–1): {mm_vals['informativeness']:.2f}

[Role]
- Assistant role: {mm_vals['assistant_role']}
"""

def log_turn(turn_index, mm_vals, mm_source, assumptions_json, user_message, assistant_message, combined_prompt):
    st.session_state.turn_logs.append({
        "turn_index": turn_index,
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "mm_locked": st.session_state.mm_locked,
        "mental_model": mm_vals,
        "mental_model_source": mm_source,
        "assumptions": assumptions_json,
        "user_message": user_message,
        "assistant_message": assistant_message,
        "combined_prompt": combined_prompt,
        "conversation_so_far": [{"role": m["role"], "content": m["content"]} for m in st.session_state.messages],
    })


# ---------------- Chat input + turn execution ----------------

user_input = st.chat_input("Type your message...")

if user_input:
    if not api_key:
        st.error("Please add your OpenAI API key in the sidebar.")
    else:
        client = OpenAI(api_key=api_key)

        # Append/show user message
        st.session_state.messages.append({"role": "user", "content": user_input})
        with st.chat_message("user"):
            st.markdown(user_input)

        is_first_assistant_turn = (st.session_state.turn_index == 0)

        # ----- 1) Mental model: infer if first turn or if unlocked, else use locked -----
        if is_first_assistant_turn:
            mm_vals = infer_mental_model_with_llm(user_input, api_key, mm_model_name)
            st.session_state.mm_values = mm_vals
            mm_source = "inferred_first_turn"
        else:
            if st.session_state.mm_locked:
                mm_vals = st.session_state.mm_values
                mm_source = "user_locked"
            else:
                mm_vals = infer_mental_model_with_llm(user_input, api_key, mm_model_name)
                st.session_state.mm_values = mm_vals
                mm_source = "inferred_unlocked"

        # ----- 2) Assumptions: infer from conversation so far (includes this user msg) -----
        convo_text = build_history_text(st.session_state.messages)
        assumptions_json = infer_uncertain_assumptions_with_llm(
            conversation_text=convo_text,
            api_key=api_key,
            model_name=assumptions_model_name,
        )
        st.session_state.assumptions_latest = assumptions_json
        st.session_state.assumptions_history.append({
            "turn_index": st.session_state.turn_index + 1,
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "assumptions": assumptions_json,
        })

        # ----- 3) Build prompt for response model -----
        preamble = build_mental_model_preamble(mm_vals)
        combined_prompt = f"""{preamble}

Conversation so far:
{convo_text}

Now respond as the assistant to the last user message in a way that respects the mental model above.
Assistant:"""

        # ----- 4) Call response model -----
        resp = client.responses.create(
            model=response_model_name,
            input=combined_prompt,
            reasoning={"effort": "none"},
        )
        assistant_reply = resp.output_text

        # Append assistant message
        st.session_state.messages.append({"role": "assistant", "content": assistant_reply})
        st.session_state.turn_index += 1

        # Log turn
        log_turn(
            turn_index=st.session_state.turn_index,
            mm_vals=mm_vals,
            mm_source=mm_source,
            assumptions_json=assumptions_json,
            user_message=user_input,
            assistant_message=assistant_reply,
            combined_prompt=combined_prompt,
        )

        # Ensure sidebar controls appear immediately after first turn
        if is_first_assistant_turn:
            st.rerun()
        else:
            with st.chat_message("assistant"):
                st.markdown(assistant_reply)
