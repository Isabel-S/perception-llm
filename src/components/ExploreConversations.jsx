import { useState, useEffect } from 'react'
import { SCENARIOS } from '../eval/scenarios.js'
import './ExploreConversations.css'

const DATA_MODEL_OPTIONS = [
  { id: 'induct', label: 'Induct' },
  { id: 'structured', label: 'Structured' },
  { id: 'support', label: 'Support' },
  { id: 'support_types', label: 'Support types' },
]

const CATEGORIES = [...new Set(SCENARIOS.map(s => s.category))].sort()

function getScenariosByCategory() {
  const byCat = {}
  for (const s of SCENARIOS) {
    if (!byCat[s.category]) byCat[s.category] = []
    byCat[s.category].push(s)
  }
  return byCat
}

const SCENARIOS_BY_CATEGORY = getScenariosByCategory()

function formatCategoryLabel(cat) {
  return cat.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

export default function ExploreConversations({ onClose }) {
  const [selectedModel, setSelectedModel] = useState(null)
  const [selectedCategory, setSelectedCategory] = useState('')
  const [selectedPromptId, setSelectedPromptId] = useState('')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const scenariosInCategory = selectedCategory ? (SCENARIOS_BY_CATEGORY[selectedCategory] || []) : []
  const promptForScenario = selectedCategory && selectedPromptId
    ? SCENARIOS.find(s => s.category === selectedCategory && s.prompt_id === selectedPromptId)
    : null

  useEffect(() => {
    if (!selectedModel || !selectedCategory || !selectedPromptId) {
      setData(null)
      return
    }
    setLoading(true)
    setError(null)
    const url = `/data/${selectedModel}/${selectedCategory}/${selectedPromptId}.json`
    fetch(url)
      .then(r => {
        if (!r.ok) throw new Error(r.status === 404 ? 'File not found' : r.statusText)
        return r.json()
      })
      .then(setData)
      .catch(e => {
        setError(e.message)
        setData(null)
      })
      .finally(() => setLoading(false))
  }, [selectedModel, selectedCategory, selectedPromptId])

  return (
    <div className="explore-conversations">
      <div className="explore-header">
        <h2 className="explore-title">Explore conversations</h2>
        <button type="button" className="explore-close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      <div className="explore-model-buttons">
        {DATA_MODEL_OPTIONS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            className={`explore-model-btn ${selectedModel === id ? 'active' : ''}`}
            onClick={() => {
              setSelectedModel(id)
              setSelectedCategory('')
              setSelectedPromptId('')
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {selectedModel && (
        <>
          <div className="explore-filters">
            <label className="explore-filter">
              <span className="explore-filter-label">Category</span>
              <select
                value={selectedCategory}
                onChange={(e) => {
                  setSelectedCategory(e.target.value)
                  setSelectedPromptId('')
                }}
                className="explore-select"
              >
                <option value="">Select category</option>
                {CATEGORIES.map(cat => (
                  <option key={cat} value={cat}>{formatCategoryLabel(cat)}</option>
                ))}
              </select>
            </label>
            <label className="explore-filter">
              <span className="explore-filter-label">Scenario</span>
              <select
                value={selectedPromptId}
                onChange={(e) => setSelectedPromptId(e.target.value)}
                className="explore-select"
                disabled={!selectedCategory}
              >
                <option value="">Select scenario</option>
                {scenariosInCategory.map(s => (
                  <option key={s.prompt_id} value={s.prompt_id}>{s.prompt_id}</option>
                ))}
              </select>
            </label>
          </div>

          {loading && <div className="explore-loading">Loading…</div>}
          {error && <div className="explore-error">{error}</div>}

          {data && !loading && (
            <div className="explore-content">
              <section className="explore-section">
                <h3 className="explore-section-title">Prompt</h3>
                <div className="explore-prompt">
                  {promptForScenario?.prompts?.[0] ?? data.turns?.[0]?.userMessage ?? '—'}
                </div>
                {data.categoryInjection && (
                  <div className="explore-meta">
                    <strong>Category injection:</strong> {data.categoryInjection}
                  </div>
                )}
                {data.extraInjection && (
                  <div className="explore-meta">
                    <strong>Extra injection:</strong> {data.extraInjection}
                  </div>
                )}
              </section>

              <section className="explore-section">
                <h3 className="explore-section-title">Conversation & mental model per turn</h3>
                <div className="explore-turns">
                  {(data.turns || []).map((turn, idx) => (
                    <div key={idx} className="explore-turn">
                      <div className="explore-turn-header">Turn {turn.turnIndex + 1}</div>
                      <div className="explore-turn-row user">
                        <span className="explore-turn-role">User</span>
                        <div className="explore-turn-bubble">{turn.userMessage}</div>
                      </div>
                      <div className="explore-turn-row assistant">
                        <span className="explore-turn-role">Assistant</span>
                        <div className="explore-turn-bubble">{turn.assistantMessage}</div>
                      </div>
                      <div className="explore-turn-mm">
                        <span className="explore-turn-role">Mental model</span>
                        <pre className="explore-mm-json">
                          <code>{JSON.stringify(turn.mentalModel ?? {}, null, 2)}</code>
                        </pre>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          )}
        </>
      )}

      {!selectedModel && (
        <p className="explore-hint">Choose a mental model above to browse conversations from the data folder.</p>
      )}
    </div>
  )
}
