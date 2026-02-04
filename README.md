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

The Azure OpenAI integration is already set up! You just need to add your API key:

1. Copy the example environment file:
```bash
cp .env.example .env
```

2. Open the `.env` file and add your Azure API key:
```
VITE_AZURE_ENDPOINT=your-actual-endpoint-here
VITE_AZURE_API_KEY=your-actual-api-key-here
VITE_AZURE_DEPLOYMENT=gpt-5.1-chat
VITE_AZURE_API_VERSION=2024-12-01-preview
```

3. Replace `your-actual-api-endpoint-here` and `your-actual-api-key-here` with your actual Azure API key

4. Restart the development server for the changes to take effect

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
