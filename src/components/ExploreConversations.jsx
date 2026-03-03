import { useState, useEffect } from 'react'
import './ExploreConversations.css'

function getDataBaseUrl() {
  const base = (typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL) || '/'
  return base.endsWith('/') ? base : base + '/'
}

const getManifestUrl = () => getDataBaseUrl() + 'data/single_call/manifest.json'
const getConversationUrl = (runId, category, promptId) =>
  getDataBaseUrl() + `data/single_call/${runId}/${category}/${promptId}.json`

function formatCategoryLabel(cat) {
  return cat.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

/** Turn folder name (e.g. run_gemini_1_prior, run_gpt-4o_2_prior_seed_42) into a readable run label for the UI. */
function formatRunDisplayLabel(run) {
  const modelLabel = run.mentalModel === 'types_support' ? 'Support' : run.mentalModel === 'induct' ? 'Induct' : (run.mentalModel || '').replace(/_/g, ' ')
  let name = (run.runFolder || run.id?.split('/')[1] || '')
  if (!name) return run.label || run.id || 'Run'

  let priorSuffix = ''
  let seedSuffix = ''

  if (name.endsWith('_prior')) {
    priorSuffix = ' (prior)'
    name = name.slice(0, -6)
  }
  const seedMatch = name.match(/_seed_(\d+)$/)
  if (seedMatch) {
    seedSuffix = ` (seed ${seedMatch[1]})`
    name = name.slice(0, -seedMatch[0].length)
  }
  if (name.endsWith('_prior')) {
    priorSuffix = ' (prior)'
    name = name.slice(0, -6)
  }

  const runMatch = name.match(/^run_(.+)_(\d+)$/)
  if (runMatch) {
    const api = runMatch[1]
    const apiNorm = api.toLowerCase().replace(/-/g, '')
    const apiLabel = apiNorm === 'gpt4o' ? 'GPT-4o' : api.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    const num = runMatch[2]
    return `${modelLabel} · ${apiLabel} run ${num}${priorSuffix}${seedSuffix}`
  }

  return modelLabel ? `${modelLabel} · ${name}` : (run.label || name)
}

export default function ExploreConversations({ onClose }) {
  const [manifest, setManifest] = useState(null)
  const [manifestLoading, setManifestLoading] = useState(true)
  const [manifestError, setManifestError] = useState(null)

  const [selectedRunId, setSelectedRunId] = useState('')
  const [selectedCategory, setSelectedCategory] = useState('')
  const [selectedPromptId, setSelectedPromptId] = useState('')

  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const runs = manifest?.runs ?? []
  const selectedRun = runs.find(r => r.id === selectedRunId)
  const categories = selectedRun ? Object.keys(selectedRun.categories).sort() : []
  const promptIds = selectedRun && selectedCategory
    ? (selectedRun.categories[selectedCategory] ?? [])
    : []

  useEffect(() => {
    setManifestLoading(true)
    setManifestError(null)
    fetch(getManifestUrl())
      .then(r => {
        if (!r.ok) throw new Error(r.status === 404 ? 'No run data on this site. Explore shows saved eval runs from a local install.' : r.statusText)
        return r.json()
      })
      .then(setManifest)
      .catch(e => {
        setManifestError(e.message)
        setManifest(null)
      })
      .finally(() => setManifestLoading(false))
  }, [])

  useEffect(() => {
    if (!selectedRunId || !selectedCategory || !selectedPromptId) {
      setData(null)
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    const url = getConversationUrl(selectedRunId, selectedCategory, selectedPromptId)
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
  }, [selectedRunId, selectedCategory, selectedPromptId])

  const resetAfterRun = (runId) => {
    setSelectedRunId(runId)
    setSelectedCategory('')
    setSelectedPromptId('')
    setData(null)
  }

  const resetAfterCategory = (cat) => {
    setSelectedCategory(cat)
    setSelectedPromptId('')
    setData(null)
  }

  return (
    <div className="explore-conversations">
      <div className="explore-header">
        <h2 className="explore-title">Explore Spiral-Bench conversations</h2>
      </div>

      {manifestLoading && <div className="explore-loading">Loading runs…</div>}
      {manifestError && (
        <div className="explore-error">
          {manifestError}
        </div>
      )}

      {manifest && !manifestLoading && (
        <>
          <div className="explore-body">
          {runs.length === 0 ? (
            <p className="explore-empty-message">No run data on this site. Explore shows saved Spiral-Bench eval runs—run evals locally to see data here, or use the Chat tab to try the app.</p>
          ) : (
          <>
          <div className="explore-runs-section">
            <h3 className="explore-runs-title">Runs</h3>
            <p className="explore-runs-desc">Click <strong>Chatlog</strong> to open conversations for a run.</p>
            <ul className="explore-runs-list">
              {runs.map(r => (
                <li key={r.id} className={`explore-runs-item ${selectedRunId === r.id ? 'explore-runs-item-selected' : ''}`}>
                  <span className="explore-runs-label">{formatRunDisplayLabel(r)}</span>
                  <button
                    type="button"
                    className="explore-runs-chatlink"
                    onClick={() => resetAfterRun(r.id)}
                  >
                    Chatlog
                  </button>
                </li>
              ))}
            </ul>
          </div>

          {selectedRunId && (
            <div className="explore-detail">
              <div className="explore-filters">
                <label className="explore-filter">
                  <span className="explore-filter-label">Category</span>
                  <select
                    value={selectedCategory}
                    onChange={(e) => resetAfterCategory(e.target.value)}
                    className="explore-select"
                  >
                    <option value="">Select category</option>
                    {categories.map(cat => (
                      <option key={cat} value={cat}>{formatCategoryLabel(cat)}</option>
                    ))}
                  </select>
                </label>
                {selectedCategory && (
                  <label className="explore-filter">
                    <span className="explore-filter-label">Conversation</span>
                    <select
                      value={selectedPromptId}
                      onChange={(e) => {
                        setSelectedPromptId(e.target.value)
                        setData(null)
                      }}
                      className="explore-select"
                    >
                      <option value="">Select conversation</option>
                      {promptIds.map(pid => (
                        <option key={pid} value={pid}>{pid}</option>
                      ))}
                    </select>
                  </label>
                )}
              </div>

              {loading && <div className="explore-loading">Loading conversation…</div>}
              {error && <div className="explore-error">{error}</div>}

              {data && !loading && (
                <div className="explore-content">
                  <section className="explore-section">
                    <h3 className="explore-section-title">Prompt</h3>
                    <div className="explore-prompt">
                      {data.turns?.[0]?.userMessage ?? '—'}
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
                    {data.api_model && (
                      <div className="explore-meta">
                        <strong>API model:</strong> {data.api_model}
                        {data.use_prior != null && (
                          <span> · Prior: {data.use_prior ? 'yes' : 'no'}</span>
                        )}
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
                          {(turn.mentalModel && Object.keys(turn.mentalModel).length > 0) && (
                            <div className="explore-turn-mm">
                              <span className="explore-turn-role">Mental model</span>
                              <pre className="explore-mm-json">
                                <code>{JSON.stringify(turn.mentalModel ?? {}, null, 2)}</code>
                              </pre>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </section>
                </div>
              )}

              {!selectedCategory && (
                <p className="explore-hint">Select a category to see conversations.</p>
              )}
              {selectedCategory && !selectedPromptId && (
                <p className="explore-hint">Select a conversation to view.</p>
              )}
            </div>
          )}

          {!selectedRunId && (
            <p className="explore-hint">
              Click <strong>Chatlog</strong> next to a run above to browse Spiral-Bench conversations.
            </p>
          )}
          </>
          )}
          </div>
        </>
      )}
    </div>
  )
}
