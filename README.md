# Person Perception

A local web application with a chat interface for interacting with an LLM and a visualization panel that displays insights based on the responses.

## Features

- 💬 Chat interface for LLM conversations
- 📊 Visualization panel for response analysis
- 🎨 Modern, dark-themed UI
- 🔌 Ready for Azure OpenAI API integration

## Setup

1. Install dependencies:
```bash
npm install
```

2. Start the development server:
```bash
npm run dev
```

3. Open your browser to the URL shown in the terminal (usually `http://localhost:5173`)

## Azure API Integration

The app supports **Azure OpenAI (GPT-4o)** and **Google Gemini**. You can switch the API model in the UI (dropdown “API model”) or in the terminal with `--api_gemini` or `--api_gpt-4o` when running `npm run run_eval`.

1. Copy the example environment file (if you have one) or create a `.env` file in the project root.

2. Add your keys to `.env`:

**Azure OpenAI (GPT-4o):**
```
VITE_AZURE_ENDPOINT=your-actual-endpoint-here
VITE_AZURE_API_KEY=your-actual-api-key-here
VITE_AZURE_DEPLOYMENT=gpt-4o
VITE_AZURE_API_VERSION=2024-12-01-preview
```

**Google Gemini (optional; use when API model = Gemini):**

- **Browser / API key:** Get an API key from [Google AI Studio](https://aistudio.google.com/apikey) and set:
  ```
  VITE_GEMINI_API_KEY=your-gemini-api-key-here
  ```
- **CLI / Node (Vertex AI with service account):** Use a Google Cloud service account JSON key (like the one you pasted) and set:
  ```
  GOOGLE_APPLICATION_CREDENTIALS=./new_key.json   # or another path to your JSON
  VITE_GEMINI_PROJECT_ID=your-gcp-project-id      # optional if JSON has project_id
  ```
  Optional: `VITE_GEMINI_LOCATION=us-central1`, `VITE_GEMINI_MODEL=gemini-1.5-flash` (or e.g. `gemini-2.5-pro`).

**Default provider (optional):**
```
# VITE_API_PROVIDER=gpt-4o
# or
# VITE_API_PROVIDER=gemini
```

3. Replace placeholder values with your actual keys.

4. Restart the development server for the changes to take effect.

## How data is saved

When you run evals (from the UI or via `npm run run_eval`), results are written under the `data/` folder. **Every saved JSON now includes `api_model`** (e.g. `"gpt-4o"` or `"gemini"`) so you know which API produced the run.

### Where things go

| Mode | Command / UI | Save location |
|------|----------------|---------------|
| **Single-call** | `--single_call --model_induct` (or `--model_support_2`) | `data/single_call/<model>/run_<api_model>_<N>/` → e.g. `run_gemini_1`, `run_gpt-4o_2`. One folder per run; inside it, one JSON per scenario (e.g. `spiral_tropes/sc01.json`). |
| **Separate call** | `--separate_call --convo_<N> --model_induct` | `data/separate_call/convo_<N>/<model>/run_<api_model>_<N>/` → same structure (e.g. `run_gemini_1`). |
| **Generate convos** | `--generate_convo` | `data/separate_call/convo_<N>/` → only user/assistant turns (no mental model); used later by separate_call. |
| **Human data** | `--human_data --model_induct --filename do_not_upload/h01.json` | `data/do_not_upload/<filename_no_ext>/<filename_no_ext>_<api_model>_<mental_model_type>.json` → e.g. `h01_gemini_induct.json`, `h01_gpt-4o_induct.json`. One file per (source, api model, mental model); re-running overwrites/resumes that file. |
| **Backfill empty** | `--backfill_empty --model_induct --file <path>` | Overwrites the given file, filling in missing mental models and updating `meta.api_model`. |

### What’s in the JSON

- **Scenario runs (single_call / separate_call):** Each file has `category`, `prompt_id`, `categoryInjection`, `extraInjection`, **`api_model`**, `turns`, and `situation_log`. Each turn has `turnIndex`, `userMessage`, `assistantMessage`, and `mentalModel`.
- **Human data runs:** Top-level `meta` (includes **`api_model`**, `source`, `mentalModelType`, `turns_recorded_up_to`, etc.) and `turns` (same turn shape as above).

So you can always see which API model was used for a run by checking `api_model` in the saved JSON.

## Project Structure

```
├── src/
│   ├── components/
│   │   ├── ChatInterface.jsx      # Chat UI component
│   │   ├── ChatInterface.css
│   │   ├── VisualizationPanel.jsx # Visualization component
│   │   └── VisualizationPanel.css
│   ├── services/
│   │   └── api.js                 # API service (ready for Azure)
│   ├── App.jsx                     # Main app component
│   ├── App.css
│   ├── main.jsx                    # Entry point
│   └── index.css                   # Global styles
├── index.html
├── package.json
└── vite.config.js
```

## Customization

- **Visualization Panel**: Customize `VisualizationPanel.jsx` to visualize specific data from LLM responses (sentiment, keywords, topics, etc.)
- **Styling**: Modify the CSS files to match your preferred design
- **API Integration**: Replace the mock API in `src/services/api.js` with your Azure OpenAI implementation
