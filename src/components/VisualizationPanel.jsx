import { useRef, useEffect } from 'react'
import './VisualizationPanel.css'

const INLINE_MENTAL_MODEL_TYPES = ['support', 'induct', 'structured', 'types_support']

const INDUCT_SERIES = [
  { key: 'validation_seeking', label: 'Validation seeking', color: '#2d5016' },
  { key: 'user_rightness', label: 'User rightness', color: '#1565c0' },
  { key: 'user_information_advantage', label: 'User info advantage', color: '#6a1b9a' },
  { key: 'objectivity_seeking', label: 'Objectivity seeking', color: '#c62828' },
]

const SUPPORT_SERIES = [
  { key: 'emotional_support', label: 'Emotional support', color: '#2d5016' },
  { key: 'social_companionship', label: 'Social & companionship', color: '#1565c0' },
  { key: 'belonging_support', label: 'Belonging support', color: '#6a1b9a' },
  { key: 'information_guidance', label: 'Information & guidance', color: '#c62828' },
  { key: 'tangible_support', label: 'Tangible support', color: '#e65100' },
]

function ScoresAcrossTurnsChart({ mentalModelsByTurn, modelType }) {
  const seriesConfig = modelType === 'induct' ? INDUCT_SERIES : modelType === 'types_support' ? SUPPORT_SERIES : []
  if (!seriesConfig.length || !mentalModelsByTurn?.length) return null

  const numTurns = mentalModelsByTurn.length
  const getScores = (mm) => {
    const inner = mm?.mental_model ?? mm
    if (modelType === 'induct') {
      const b = inner?.beliefs ?? {}
      return seriesConfig.map(s => (typeof b[s.key]?.score === 'number' ? b[s.key].score : null))
    }
    const s = inner?.support_seeking ?? {}
    return seriesConfig.map(spec => (typeof s[spec.key]?.score === 'number' ? s[spec.key].score : null))
  }

  const series = seriesConfig.map((spec, idx) => ({
    ...spec,
    values: mentalModelsByTurn.map(mm => getScores(mm)[idx]),
  }))

  const width = 400
  const height = 220
  const padding = { left: 44, right: 12, top: 12, bottom: 32 }
  const innerWidth = width - padding.left - padding.right
  const innerHeight = height - padding.top - padding.bottom

  const xScale = (i) => padding.left + (numTurns <= 1 ? 0 : (i / Math.max(1, numTurns - 1)) * innerWidth)
  const yScale = (v) => padding.top + innerHeight - (v != null && v >= 0 && v <= 1 ? v * innerHeight : innerHeight / 2)

  const polylinePath = (values) => {
    const pts = values.map((v, i) => (v != null ? [xScale(i), yScale(v)] : null))
    const valid = pts.filter(Boolean)
    if (valid.length < 2) return valid.length ? `M ${valid[0][0]} ${valid[0][1]}` : ''
    return 'M ' + valid.map(([x, y]) => `${x} ${y}`).join(' L ')
  }

  return (
    <div className="scores-across-turns-chart">
      <h4>Scores across turns</h4>
      <svg viewBox={`0 0 ${width} ${height}`} className="scores-chart-svg" preserveAspectRatio="xMidYMid meet">
        {/* Y grid & axis */}
        {[0, 0.25, 0.5, 0.75, 1].map((v, i) => (
          <g key={i}>
            <line x1={padding.left} y1={yScale(v)} x2={padding.left + innerWidth} y2={yScale(v)} className="chart-grid" />
            <text x={padding.left - 6} y={yScale(v) + 4} className="chart-axis-label" textAnchor="end">{v}</text>
          </g>
        ))}
        {/* X axis labels */}
        {numTurns <= 8
          ? Array.from({ length: numTurns }, (_, i) => (
              <text key={i} x={xScale(i)} y={height - 8} className="chart-axis-label" textAnchor="middle">T{i + 1}</text>
            ))
          : Array.from({ length: 5 }, (_, i) => {
              const idx = i === 4 ? numTurns - 1 : Math.round((i / 4) * (numTurns - 1))
              return (
                <text key={i} x={xScale(idx)} y={height - 8} className="chart-axis-label" textAnchor="middle">T{idx + 1}</text>
              )
            })}
        {/* Lines */}
        {series.map((s, i) => (
          <path key={s.key} d={polylinePath(s.values)} fill="none" stroke={s.color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="chart-line" />
        ))}
        {/* Dots at each point */}
        {series.map((s) =>
          s.values.map((v, turnIdx) =>
            v != null && v >= 0 && v <= 1 ? (
              <circle key={`${s.key}-${turnIdx}`} cx={xScale(turnIdx)} cy={yScale(v)} r={3} fill={s.color} className="chart-dot" />
            ) : null
          )
        )}
      </svg>
      <div className="scores-chart-legend">
        {series.map(s => (
          <span key={s.key} className="scores-chart-legend-item">
            <span className="scores-chart-legend-dot" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  )
}

function VisualizationPanel({ assumptions, assumptionsHistory, mentalModel, mentalModelsByTurn = [], isLoadingMentalModel, isLoadingAssumptions, useOldModel, mentalModelType }) {
  const showJsonOnly = INLINE_MENTAL_MODEL_TYPES.includes(mentalModelType)
  const baselineMentalModelRef = useRef(null)

  // Track baseline mental model (value before current update cycle started)
  // This allows change indicators to persist showing difference from baseline
  useEffect(() => {
    // When loading starts, capture current value as baseline for comparison
    if (isLoadingMentalModel && mentalModel) {
      baselineMentalModelRef.current = JSON.parse(JSON.stringify(mentalModel))
    }
    // When loading completes and we have new data, keep baseline for comparison
    // Baseline will be updated when next loading cycle starts
    if (mentalModel && !isLoadingMentalModel && !baselineMentalModelRef.current) {
      // First time we get data, set it as baseline
      baselineMentalModelRef.current = JSON.parse(JSON.stringify(mentalModel))
    }
  }, [mentalModel, isLoadingMentalModel])

  // Helper to get nested value from object using path string
  const getNestedValue = (obj, path) => {
    return path.split('.').reduce((current, key) => current?.[key], obj)
  }

  const getChangeIndicator = (path, currentValue) => {
    // Always compare to baseline (value before current update cycle)
    if (!baselineMentalModelRef.current) return null
    
    const prevValue = getNestedValue(baselineMentalModelRef.current, path)
    if (prevValue === undefined) return null
    
    if (typeof currentValue === 'string') {
      if (prevValue !== currentValue) {
        return <span className="change-indicator role-change">({prevValue} → {currentValue})</span>
      }
      return null
    }
    
    if (typeof currentValue === 'boolean') {
      if (prevValue !== currentValue) {
        return <span className="change-indicator boolean-change">({prevValue ? 'Yes' : 'No'} → {currentValue ? 'Yes' : 'No'})</span>
      }
      return null
    }
    
    if (typeof currentValue === 'number') {
      const diff = currentValue - prevValue
      if (Math.abs(diff) > 0.01) { // Only show if change is significant
        const diffPercent = Math.abs(currentValue) <= 1 && Math.abs(prevValue) <= 1 
          ? (diff * 100).toFixed(0) 
          : diff.toFixed(2)
        const isPositive = diff > 0
        return (
          <span className={`change-indicator ${isPositive ? 'positive' : 'negative'}`}>
            {isPositive ? '+' : ''}{diffPercent}{Math.abs(currentValue) <= 1 ? '%' : ''}
          </span>
        )
      }
      return null
    }
    
    return null
  }

  const formatValue = (value, isPercent = false) => {
    if (typeof value === 'number') {
      if (isPercent) {
        return `${(value * 100).toFixed(0)}%`
      }
      // For -1 to 1 scale, show as decimal
      if (value >= -1 && value <= 1) {
        return value.toFixed(2)
      }
      return value.toFixed(0)
    }
    return String(value || 'N/A')
  }

  const renderInductModel = () => {
    if (!mentalModel) return <p className="no-assumptions">Loading mental model...</p>
    const mm = mentalModel.mental_model ?? mentalModel
    const beliefs = mm?.beliefs ?? {}
    const beliefKeys = [
      { key: 'validation_seeking', label: 'Validation seeking' },
      { key: 'user_rightness', label: 'User rightness' },
      { key: 'user_information_advantage', label: 'User information advantage' },
      { key: 'objectivity_seeking', label: 'Objectivity seeking' },
    ]
    return (
      <div className="new-model-display">
        <div className="model-section">
          <h4>Beliefs</h4>
          <div className="model-subsection">
            {beliefKeys.map(({ key, label }) => {
              const item = beliefs[key]
              if (!item) return null
              const score = typeof item.score === 'number' ? item.score : null
              const path = `mental_model.beliefs.${key}.score`
              return (
                <div key={key} className="mental-model-item">
                  <span className="mental-model-label">{label}:</span>
                  <span className="mental-model-value">
                    {score != null ? formatValue(score, true) : 'N/A'}
                    {getChangeIndicator(path, score)}
                  </span>
                  {item.explanation && (
                    <div className="mental-model-explanation">{item.explanation}</div>
                  )}
                </div>
              )
            })}
            {beliefKeys.every(({ key }) => !beliefs[key]) && (
              <p className="no-data">No beliefs yet</p>
            )}
          </div>
        </div>
      </div>
    )
  }

  const renderStructuredModel = () => {
    if (!mentalModel) return <p className="no-assumptions">Loading mental model...</p>
    const models = mentalModel.mental_models ?? (Array.isArray(mentalModel) ? mentalModel : [])
    return (
      <div className="new-model-display">
        <div className="model-section">
          <h4>Top mental models</h4>
          <div className="model-subsection structured-models-list">
            {models.length === 0 && <p className="no-data">No models inferred yet</p>}
            {models.map((m, idx) => (
              <div key={idx} className="structured-model-card">
                <div className="structured-model-header">
                  <span className="structured-model-name">{m.model_name || '—'}</span>
                  <span className="structured-model-probability">
                    {typeof m.probability === 'number' ? `${(m.probability * 100).toFixed(0)}%` : '—'}
                  </span>
                </div>
                <div className="structured-model-description">{m.description || '—'}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    )
  }

  const renderSupportModel = () => {
    if (!mentalModel) return <p className="no-assumptions">Loading mental model...</p>
    const mm = mentalModel.mental_model ?? mentalModel
    const supportSeeking = mm?.support_seeking ?? {}
    const supportKeys = [
      { key: 'emotional_support', label: 'Emotional support' },
      { key: 'social_companionship', label: 'Social & companionship' },
      { key: 'belonging_support', label: 'Belonging support' },
      { key: 'information_guidance', label: 'Information & guidance' },
      { key: 'tangible_support', label: 'Tangible support' },
    ]
    return (
      <div className="new-model-display">
        <div className="model-section">
          <h4>Support seeking</h4>
          <div className="model-subsection">
            {supportKeys.map(({ key, label }) => {
              const item = supportSeeking[key]
              if (!item) return null
              const score = typeof item.score === 'number' ? item.score : null
              const path = `mental_model.support_seeking.${key}.score`
              return (
                <div key={key} className="mental-model-item">
                  <span className="mental-model-label">{label}:</span>
                  <span className="mental-model-value">
                    {score != null ? formatValue(score, true) : 'N/A'}
                    {getChangeIndicator(path, score)}
                  </span>
                  {item.explanation && (
                    <div className="mental-model-explanation">{item.explanation}</div>
                  )}
                </div>
              )
            })}
            {supportKeys.every(({ key }) => !supportSeeking[key]) && (
              <p className="no-data">No support-seeking scores yet</p>
            )}
          </div>
        </div>
      </div>
    )
  }

  const renderOldModel = () => {
    if (!mentalModel) return <p className="no-assumptions">Loading mental model...</p>
    
    return (
      <div className="mental-model-grid">
        <div className="mental-model-item">
          <span className="mental-model-label">User Certainty:</span>
          <span className="mental-model-value">
            {(mentalModel.user_certainty * 100).toFixed(0)}%
            {getChangeIndicator('user_certainty', mentalModel.user_certainty)}
          </span>
        </div>
        <div className="mental-model-item">
          <span className="mental-model-label">Model Seen as Expert:</span>
          <span className="mental-model-value">
            {(mentalModel.model_seen_as_expert * 100).toFixed(0)}%
            {getChangeIndicator('model_seen_as_expert', mentalModel.model_seen_as_expert)}
          </span>
        </div>
        <div className="mental-model-item">
          <span className="mental-model-label">Expects Correction:</span>
          <span className="mental-model-value">
            {mentalModel.expects_correction ? 'Yes' : 'No'}
            {getChangeIndicator('expects_correction', mentalModel.expects_correction)}
          </span>
        </div>
        <div className="mental-model-item">
          <span className="mental-model-label">Validation Seeking:</span>
          <span className="mental-model-value">
            {(mentalModel.validation_seeking * 100).toFixed(0)}%
            {getChangeIndicator('validation_seeking', mentalModel.validation_seeking)}
          </span>
        </div>
        <div className="mental-model-item">
          <span className="mental-model-label">Objectivity Seeking:</span>
          <span className="mental-model-value">
            {(mentalModel.objectivity_seeking * 100).toFixed(0)}%
            {getChangeIndicator('objectivity_seeking', mentalModel.objectivity_seeking)}
          </span>
        </div>
        <div className="mental-model-item">
          <span className="mental-model-label">Empathy Expectation:</span>
          <span className="mental-model-value">
            {(mentalModel.empathy_expectation * 100).toFixed(0)}%
            {getChangeIndicator('empathy_expectation', mentalModel.empathy_expectation)}
          </span>
        </div>
        <div className="mental-model-item">
          <span className="mental-model-label">Directness:</span>
          <span className="mental-model-value">
            {(mentalModel.directness * 100).toFixed(0)}%
            {getChangeIndicator('directness', mentalModel.directness)}
          </span>
        </div>
        <div className="mental-model-item">
          <span className="mental-model-label">Informativeness:</span>
          <span className="mental-model-value">
            {(mentalModel.informativeness * 100).toFixed(0)}%
            {getChangeIndicator('informativeness', mentalModel.informativeness)}
          </span>
        </div>
        <div className="mental-model-item">
          <span className="mental-model-label">Assistant Role:</span>
          <span className="mental-model-value">
            {mentalModel.assistant_role}
            {getChangeIndicator('assistant_role', mentalModel.assistant_role)}
          </span>
        </div>
      </div>
    )
  }

  const renderNewModel = () => {
    if (!mentalModel) return <p className="no-assumptions">Loading mental model...</p>
    
    return (
      <div className="new-model-display">
        {/* Behavior */}
        <div className="model-section behavior-section">
          <h4>Behavior</h4>
          <div className="model-subsection behavior-subsection">
            <div className="mental-model-item">
              <span className="mental-model-label">Turn ID:</span>
              <span className="mental-model-value">{mentalModel.behavior?.turn_id || 'N/A'}</span>
            </div>
            {mentalModel.behavior?.observations?.length > 0 ? (
              <div className="behavior-observations">
                {mentalModel.behavior.observations.map((obs, idx) => (
                  <div key={idx} className="observation-block">
                    <div className="observation-evidence">
                      <span className="mental-model-label">Observed evidence:</span>
                      <span className="mental-model-value">{obs.observed_evidence || '—'}</span>
                    </div>
                    <div className="observation-diagnosticity">
                      <div className="mental-model-item">
                        <span className="mental-model-label">Situational force:</span>
                        <span className="mental-model-value">
                          {formatValue(obs.diagnosticity?.situational_force, true)}
                          {getChangeIndicator(`behavior.observations.${idx}.diagnosticity.situational_force`, obs.diagnosticity?.situational_force)}
                        </span>
                      </div>
                      <div className="mental-model-item">
                        <span className="mental-model-label">Consistency:</span>
                        <span className="mental-model-value">
                          {formatValue(obs.diagnosticity?.consistency, true)}
                          {getChangeIndicator(`behavior.observations.${idx}.diagnosticity.consistency`, obs.diagnosticity?.consistency)}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="no-data">No observations</p>
            )}
          </div>
        </div>

        {/* Mental State */}
        <div className="model-section">
          <h4>Mental State</h4>
          <div className="model-subsection">
            <div className="subsection-title">Mind3D</div>
            <div className="mental-model-item">
              <span className="mental-model-label">Rationality:</span>
              <span className="mental-model-value">
                {formatValue(mentalModel.mental_state?.mind3d?.rationality)}
                {getChangeIndicator('mental_state.mind3d.rationality', mentalModel.mental_state?.mind3d?.rationality)}
              </span>
            </div>
            <div className="mental-model-item">
              <span className="mental-model-label">Valence:</span>
              <span className="mental-model-value">
                {formatValue(mentalModel.mental_state?.mind3d?.valence)}
                {getChangeIndicator('mental_state.mind3d.valence', mentalModel.mental_state?.mind3d?.valence)}
              </span>
            </div>
            <div className="mental-model-item">
              <span className="mental-model-label">Social Impact:</span>
              <span className="mental-model-value">
                {formatValue(mentalModel.mental_state?.mind3d?.social_impact)}
                {getChangeIndicator('mental_state.mind3d.social_impact', mentalModel.mental_state?.mind3d?.social_impact)}
              </span>
            </div>
            
            <div className="subsection-title">Intent & Relations</div>
            <div className="mental-model-item">
              <span className="mental-model-label">Immediate Intent:</span>
              <span className="mental-model-value">
                {mentalModel.mental_state?.immediate_intent?.label || 'N/A'} ({((mentalModel.mental_state?.immediate_intent?.confidence ?? 0) * 100).toFixed(0)}%)
              </span>
            </div>
            <div className="mental-model-item">
              <span className="mental-model-label">Horizontal Warmth:</span>
              <span className="mental-model-value">
                {formatValue(mentalModel.mental_state?.horizontal_warmth)}
                {getChangeIndicator('mental_state.horizontal_warmth', mentalModel.mental_state?.horizontal_warmth)}
              </span>
            </div>
            <div className="mental-model-item">
              <span className="mental-model-label">Vertical Competence:</span>
              <span className="mental-model-value">
                {formatValue(mentalModel.mental_state?.vertical_competence)}
                {getChangeIndicator('mental_state.vertical_competence', mentalModel.mental_state?.vertical_competence)}
              </span>
            </div>
            <div className="mental-model-item">
              <span className="mental-model-label">Role Hypothesis:</span>
              <span className="mental-model-value">
                {mentalModel.mental_state?.role_hypothesis?.label || 'N/A'} ({((mentalModel.mental_state?.role_hypothesis?.confidence ?? 0) * 100).toFixed(0)}%)
              </span>
            </div>
            <div className="mental-model-item">
              <span className="mental-model-label">User Model of LLM:</span>
              <span className="mental-model-value">
                {mentalModel.mental_state?.user_model_of_llm?.label || 'N/A'} ({((mentalModel.mental_state?.user_model_of_llm?.confidence ?? 0) * 100).toFixed(0)}%)
              </span>
            </div>
          </div>
        </div>

        {/* Motives & Goals */}
        <div className="model-section">
          <h4>Motives & Goals</h4>
          <div className="model-subsection">
            {mentalModel.motives_goals?.inferred_motives?.length > 0 ? (
              mentalModel.motives_goals.inferred_motives.map((motive, idx) => (
                <div key={idx} className="note-item">
                  <span className="note-hypothesis">{motive.label}</span>
                  <span className="note-confidence">{((motive.confidence ?? 0) * 100).toFixed(0)}%</span>
                </div>
              ))
            ) : (
              <p className="no-data">No motives inferred</p>
            )}
            <div className="mental-model-item">
              <span className="mental-model-label">Goal:</span>
              <span className="mental-model-value">
                {mentalModel.motives_goals?.goal?.label || 'N/A'} ({((mentalModel.motives_goals?.goal?.confidence ?? 0) * 100).toFixed(0)}%)
              </span>
            </div>
          </div>
        </div>

        {/* Long-term (items: candidates and traits) */}
        <div className="model-section">
          <h4>Long-term</h4>
          <div className="model-subsection">
            {mentalModel.long_term?.items && mentalModel.long_term.items.length > 0 ? (
              mentalModel.long_term.items.map((item, idx) => (
                <div key={idx} className="candidate-item">
                  <span className="candidate-label">{item.label || 'N/A'}</span>
                  <span className="candidate-type">{item.type || 'preference'}</span>
                  <span className="candidate-status">{item.status || 'candidate'}</span>
                  <span className="candidate-confidence">{((item.confidence ?? 0) * 100).toFixed(0)}%</span>
                  {item.evidence_turn_ids && item.evidence_turn_ids.length > 0 && (
                    <span className="candidate-evidence">Evidence: {item.evidence_turn_ids.join(', ')}</span>
                  )}
                </div>
              ))
            ) : (
              <p className="no-data">No long-term items</p>
            )}
          </div>
        </div>

        {/* Memory — raw JSON */}
        <div className="model-section">
          <h4>Memory</h4>
          <div className="model-subsection">
            <pre className="memory-json">
              {mentalModel.memory != null
                ? JSON.stringify(mentalModel.memory, null, 2)
                : '{}'}
            </pre>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="visualization-panel">
      <div className="visualization-header">
        <h1>Mental model</h1>
      </div>
      
      <div className="visualization-content">
        {showJsonOnly ? (
          !mentalModel && !isLoadingMentalModel ? (
            <div className="empty-visualization">
              <p>Mental model will appear here after the first response</p>
            </div>
          ) : mentalModelType === 'induct' ? (
            <div className="assumptions-display">
              <div className="mental-model-display">
                <h3>
                  Induct
                  {isLoadingMentalModel && <span className="loading-indicator">⟳</span>}
                </h3>
                {renderInductModel()}
                <ScoresAcrossTurnsChart mentalModelsByTurn={mentalModelsByTurn} modelType="induct" />
              </div>
            </div>
          ) : mentalModelType === 'types_support' ? (
            <div className="assumptions-display">
              <div className="mental-model-display">
                <h3>
                  Support
                  {isLoadingMentalModel && <span className="loading-indicator">⟳</span>}
                </h3>
                {renderSupportModel()}
                <ScoresAcrossTurnsChart mentalModelsByTurn={mentalModelsByTurn} modelType="types_support" />
              </div>
            </div>
          ) : mentalModelType === 'structured' ? (
            <div className="assumptions-display">
              <div className="mental-model-display">
                <h3>
                  Structured
                  {isLoadingMentalModel && <span className="loading-indicator">⟳</span>}
                </h3>
                {renderStructuredModel()}
              </div>
            </div>
          ) : (
            <div className="assumptions-display">
              {(mentalModel || isLoadingMentalModel) && (
                <div className="mental-model-display">
                  <h3>
                    {mentalModelType}
                    {isLoadingMentalModel && <span className="loading-indicator">⟳</span>}
                  </h3>
                  <pre className="mental-model-json"><code>{JSON.stringify(mentalModel || {}, null, 2)}</code></pre>
                </div>
              )}
            </div>
          )
        ) : !mentalModel && (!useOldModel || (!assumptions && !isLoadingAssumptions)) && !isLoadingMentalModel ? (
          <div className="empty-visualization">
            <p>Mental model{useOldModel ? ' and assumptions' : ''} will appear here after the first response</p>
          </div>
        ) : (
          <div className="assumptions-display">
            {(mentalModel || isLoadingMentalModel) && (
              <div className="mental-model-display">
                <h3>
                  {useOldModel ? 'Mental Model (Old)' : 'TurnState (New)'} (Unlocked - Auto-updating)
                  {isLoadingMentalModel && <span className="loading-indicator">⟳</span>}
                </h3>
                {useOldModel ? renderOldModel() : renderNewModel()}
              </div>
            )}

            {/* Assumptions only shown for old model */}
            {useOldModel && (assumptions || isLoadingAssumptions) && (
              <div className="assumptions-latest">
                <h3>
                  Inferred Assumptions (Latest Turn)
                  {isLoadingAssumptions && <span className="loading-indicator">⟳</span>}
                </h3>
                {assumptions && assumptions.assumptions && assumptions.assumptions.length > 0 ? (
                <div className="assumptions-list">
                  {assumptions.assumptions.map((item, index) => (
                    <div key={index} className="assumption-item">
                      <div className="assumption-header">
                        <span className="assumption-text">{item.assumption}</span>
                        <span className="assumption-probability">
                          {(item.probability * 100).toFixed(0)}%
                        </span>
                      </div>
                      {item.evidence && (
                        <div className="assumption-evidence">
                          Evidence: {item.evidence}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : assumptions ? (
                <p className="no-assumptions">No assumptions inferred</p>
              ) : (
                <p className="no-assumptions">Loading assumptions...</p>
              )}
              </div>
            )}

            {useOldModel && assumptionsHistory.length > 0 && (
              <div className="assumptions-history">
                <h3>Assumptions History</h3>
                <div className="history-list">
                  {assumptionsHistory.map((entry, idx) => (
                    <details key={idx} className="history-entry">
                      <summary>
                        Turn {entry.turn_index} - {new Date(entry.timestamp).toLocaleTimeString()}
                      </summary>
                      <div className="history-assumptions">
                        {entry.assumptions.assumptions && entry.assumptions.assumptions.length > 0 ? (
                          entry.assumptions.assumptions.map((item, itemIdx) => (
                            <div key={itemIdx} className="assumption-item">
                              <div className="assumption-header">
                                <span className="assumption-text">{item.assumption}</span>
                                <span className="assumption-probability">
                                  {(item.probability * 100).toFixed(0)}%
                                </span>
                              </div>
                              {item.evidence && (
                                <div className="assumption-evidence">
                                  Evidence: {item.evidence}
                                </div>
                              )}
                            </div>
                          ))
                        ) : (
                          <p>No assumptions</p>
                        )}
                      </div>
                    </details>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default VisualizationPanel
