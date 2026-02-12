import { useRef, useEffect } from 'react'
import './VisualizationPanel.css'

const INLINE_MENTAL_MODEL_TYPES = ['support', 'induct', 'structured', 'types_support']

function VisualizationPanel({ assumptions, assumptionsHistory, mentalModel, isLoadingMentalModel, isLoadingAssumptions, useOldModel, mentalModelType }) {
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
        <h1>{showJsonOnly ? 'Mental model' : 'person perception'}</h1>
      </div>
      
      <div className="visualization-content">
        {showJsonOnly ? (
          !mentalModel && !isLoadingMentalModel ? (
            <div className="empty-visualization">
              <p>Mental model will appear here after the first response</p>
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
