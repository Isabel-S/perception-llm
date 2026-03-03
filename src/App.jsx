import { useState, useEffect } from 'react'
import ChatInterface from './components/ChatInterface'
import VisualizationPanel from './components/VisualizationPanel'
import ExploreConversations from './components/ExploreConversations'
import { sendMessageToLLM, sendMessageWithInlineMentalModel, sendMessageSeparateMentalModelAndResponse, inferUncertainAssumptions, inferMentalModel, inferMentalModelOld, run_simulations, runHumanDataAnalysis, setApiProvider } from './services/api'
import { DEFAULT_SEEKER_PROMPT } from './eval/default_prompt.js'
import './App.css'

function App() {
  const [messages, setMessages] = useState([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState(null)
  const [assumptions, setAssumptions] = useState(null)
  const [assumptionsHistory, setAssumptionsHistory] = useState([])
  const [mentalModel, setMentalModel] = useState(null)
  const [turnIndex, setTurnIndex] = useState(0)
  const [isLoadingMentalModel, setIsLoadingMentalModel] = useState(false)
  const [isLoadingAssumptions, setIsLoadingAssumptions] = useState(false)
  const [mentalModelType, setMentalModelType] = useState('induct') // 'person_perception' | 'support' | 'induct' | 'structured' | 'types_support'
  const [separateMentalModelResponse, setSeparateMentalModelResponse] = useState(false) // two independent calls: mental model only, then response only
  const [usePrior, setUsePrior] = useState(false) // include previous turn mental model (scores only) in prompt for induct/types_support
  const [mentalModelsByTurn, setMentalModelsByTurn] = useState([]) // one mental model per completed turn (for Prior: all past turns in conversation log)
  const useOldModel = mentalModelType === 'old_model'
  const [memory, setMemory] = useState({ turn_index: [] }) // Memory for new model
  const [evalTestStatus, setEvalTestStatus] = useState(null)
  const [evalFullStatus, setEvalFullStatus] = useState(null)
  const [evalFullProgress, setEvalFullProgress] = useState('')
  const [startFromScenario, setStartFromScenario] = useState(1)
  const [evalSeed, setEvalSeed] = useState(42)
  const [evalMessages, setEvalMessages] = useState([])
  const [evalMentalModel, setEvalMentalModel] = useState(null)
  const [evalMentalModelsByTurn, setEvalMentalModelsByTurn] = useState([])
  const [evalScenarioLabel, setEvalScenarioLabel] = useState('')
  const [evalSeekerPrompt, setEvalSeekerPrompt] = useState({ default: '', categoryInjection: '', extraInjection: '' })
  const [viewMode, setViewMode] = useState('chat') // 'chat' | 'explore'
  const [humanDataStatus, setHumanDataStatus] = useState(null)
  const [humanDataProgress, setHumanDataProgress] = useState('')
  const [humanDataResumeJson, setHumanDataResumeJson] = useState(null)
  const [humanDataResumeFileName, setHumanDataResumeFileName] = useState(null)
  const [humanDataUploadedJson, setHumanDataUploadedJson] = useState(null)
  const [humanDataUploadedFileName, setHumanDataUploadedFileName] = useState(null)
  const [apiProvider, setApiProviderState] = useState('gpt-4o')

  useEffect(() => {
    setApiProvider(apiProvider)
  }, [apiProvider])

  const handleSendMessage = async (message) => {
    // Add user message
    const userMessage = {
      id: Date.now(),
      role: 'user',
      content: message,
      timestamp: new Date()
    }
    
    setMessages(prev => [...prev, userMessage])
    setIsLoading(true)
    setError(null)

    try {
      // Convert messages to format expected by API (without id and timestamp)
      const conversationHistory = messages.map(msg => ({
        role: msg.role,
        content: msg.content
      }))

      const isInlineMentalModel = ['support', 'induct', 'structured', 'types_support'].includes(mentalModelType)
      setIsLoadingMentalModel(true)
      const turnId = `t${String(turnIndex).padStart(3, '0')}`
      let mmData = null
      let response

      try {
        if (isInlineMentalModel) {
          const priorMentalModelsByTurn = (usePrior && ['induct', 'types_support'].includes(mentalModelType)) ? mentalModelsByTurn : null
          const result = separateMentalModelResponse
            ? await sendMessageSeparateMentalModelAndResponse(conversationHistory, message, mentalModelType, priorMentalModelsByTurn)
            : await sendMessageWithInlineMentalModel(conversationHistory, message, mentalModelType, priorMentalModelsByTurn)
          mmData = result.mentalModel
          response = result.response
          setMentalModel(mmData)
          setMentalModelsByTurn(prev => [...prev, mmData])
        } else {
          mmData = useOldModel
            ? await inferMentalModelOld(message)
            : await inferMentalModel(message, turnId, memory)
          setMentalModel(mmData)
          if (!useOldModel && mmData?.memory) {
            setMemory(mmData.memory)
          }
          response = await sendMessageToLLM(message, conversationHistory, {
            useOldModel,
            mentalModel: mmData,
          })
        }
      } catch (mmError) {
        console.error('Error inferring mental model / response:', mmError)
        throw mmError
      } finally {
        setIsLoadingMentalModel(false)
      }
      
      const assistantMessage = {
        id: Date.now() + 1,
        role: 'assistant',
        content: response,
        timestamp: new Date()
      }
      
      // Update messages with assistant response
      const updatedMessages = [...messages, userMessage, assistantMessage]
      setMessages(updatedMessages)
      
      // Increment turn index
      setTurnIndex(prev => prev + 1)
      
      // Clear loading state as soon as assistant response is ready
      setIsLoading(false)

      // Infer uncertain assumptions after assistant response (in background)
      // Only for old model - new model doesn't use assumptions
      if (useOldModel) {
        const fullConversationHistory = [...conversationHistory, 
          { role: 'user', content: message },
          { role: 'assistant', content: response }
        ]

        // Run assumptions inference in background (don't block UI)
        setIsLoadingAssumptions(true)
        inferUncertainAssumptions(fullConversationHistory)
          .then(assumptionsData => {
            setAssumptions(assumptionsData)
            setIsLoadingAssumptions(false)
            
            // Add to history
            setAssumptionsHistory(prev => [...prev, {
              turn_index: prev.length + 1,
              timestamp: new Date().toISOString(),
              assumptions: assumptionsData
            }])
          })
          .catch(assumptionsError => {
            console.error('Error inferring assumptions:', assumptionsError)
            setIsLoadingAssumptions(false)
            // Don't fail the whole request if assumptions fail
          })
      }
    } catch (err) {
      console.error('Error sending message:', err)
      setError(err.message || 'Failed to get response from AI')
      
      // Add error message to chat
      const errorMessage = {
        id: Date.now() + 1,
        role: 'assistant',
        content: `Error: ${err.message || 'Failed to get response. Please check your API configuration.'}`,
        timestamp: new Date()
      }
      setMessages(prev => [...prev, errorMessage])
      setIsLoading(false)
      // Clear loading states for mental model and assumptions on error
      setIsLoadingMentalModel(false)
      setIsLoadingAssumptions(false)
    }
  }

  const runEvalTest = async () => {
    setEvalTestStatus('running')
    setEvalMessages([])
    setEvalScenarioLabel('')
    try {
      const result = await run_simulations({
        mentalModelType,
        useOldModel,
        useSeparateMentalModelResponse: separateMentalModelResponse,
        numTurns: 20,
        seed: evalSeed,
        maxScenarios: 1,
        downloadWhenDone: true,
        onScenarioStart: (runId, cat, pid, categoryInjection, extraInjection) => {
          setEvalMessages([])
          setEvalMentalModelsByTurn([])
          setEvalScenarioLabel(`${cat}/${pid}`)
          setEvalSeekerPrompt({
            default: DEFAULT_SEEKER_PROMPT,
            categoryInjection: categoryInjection || '',
            extraInjection: extraInjection || ''
          })
        },
        onTurn: (runId, cat, pid, turnIndex, userMessage, assistantMessage, mentalModel) => {
          const ts = Date.now()
          setEvalMessages(prev => [...prev,
            { id: ts + turnIndex * 2, role: 'user', content: userMessage, timestamp: new Date() },
            { id: ts + turnIndex * 2 + 1, role: 'assistant', content: assistantMessage, timestamp: new Date() }
          ])
          setEvalMentalModel(mentalModel)
          setEvalMentalModelsByTurn(prev => [...prev, mentalModel])
        },
        onProgress: (runId, cat, pid, t, total) =>
          console.log(`Eval: ${runId} ${cat}/${pid} turn ${t + 1}/${total}`),
        usePrior: (mentalModelType === 'induct' || mentalModelType === 'types_support') && usePrior,
      })
      console.log('Eval test result:', result)
      setEvalTestStatus(`Done. runId=${result.runId}. ZIP downloaded.`)
    } catch (err) {
      console.error('Eval test error:', err)
      setEvalTestStatus(`Error: ${err.message}`)
    }
  }

  const runEvalFull = async () => {
    setEvalFullStatus('running')
    setEvalFullProgress('')
    setEvalMessages([])
    setEvalScenarioLabel('')
    try {
      let step = 0
      const result = await run_simulations({
        mentalModelType,
        useOldModel,
        useSeparateMentalModelResponse: separateMentalModelResponse,
        numTurns: 20,
        seed: evalSeed,
        startScenarioIndex: Math.max(0, startFromScenario - 1),
        downloadWhenDone: true,
        onScenarioStart: (runId, cat, pid, categoryInjection, extraInjection) => {
          setEvalMessages([])
          setEvalMentalModelsByTurn([])
          setEvalScenarioLabel(`${cat}/${pid}`)
          setEvalSeekerPrompt({
            default: DEFAULT_SEEKER_PROMPT,
            categoryInjection: categoryInjection || '',
            extraInjection: extraInjection || ''
          })
        },
        onTurn: (runId, cat, pid, turnIndex, userMessage, assistantMessage, mentalModel) => {
          setEvalMessages(prev => [...prev,
            { id: Date.now() + turnIndex * 2, role: 'user', content: userMessage, timestamp: new Date() },
            { id: Date.now() + turnIndex * 2 + 1, role: 'assistant', content: assistantMessage, timestamp: new Date() }
          ])
          setEvalMentalModel(mentalModel)
          setEvalMentalModelsByTurn(prev => [...prev, mentalModel])
        },
        onProgress: (runId, cat, pid, t, total, globalNum) => {
          step += 1
          const scenarioNum = globalNum ?? Math.ceil(step / 20)
          const msg = `Eval: ${runId} Scenario ${scenarioNum}/30 · ${cat}/${pid} turn ${t + 1}/${total}`
          console.log(msg)
          setEvalFullProgress(`Scenario ${scenarioNum}/30 · ${cat}/${pid} turn ${t + 1}/${total}`)
        },
        usePrior: (mentalModelType === 'induct' || mentalModelType === 'types_support') && usePrior,
      })
      setEvalFullStatus(`Done. runId=${result.runId}. ZIP downloaded.`)
      setEvalFullProgress('')
    } catch (err) {
      console.error('Full eval error:', err)
      setEvalFullStatus(`Error: ${err.message}`)
      setEvalFullProgress('')
    }
  }

  const runHumanData = async (resumeFrom = null) => {
    if (!['induct', 'types_support'].includes(mentalModelType)) {
      setHumanDataStatus('Error: Human data analysis only supports Induct or Support.')
      return
    }
    const json = humanDataUploadedJson && humanDataUploadedJson.messages?.length ? humanDataUploadedJson : null
    if (!json) {
      setHumanDataStatus('Error: Upload a conversation file (JSON with messages).')
      return
    }
    const sourceName = (humanDataUploadedFileName || 'uploaded.json').replace(/\.json$/i, '')
    const dataPath = `do_not_upload/${sourceName}.json`
    setHumanDataStatus('running')
    setEvalMessages([])
    setEvalMentalModelsByTurn([])
    setEvalScenarioLabel(`Human: ${humanDataUploadedFileName || sourceName}`)
    setHumanDataProgress('')
    try {
      const result = await runHumanDataAnalysis({
        dataPath,
        rawData: json,
        mentalModelType,
        usePrior,
        existingResult: resumeFrom ?? undefined,
        onTurn: (runId, sourceId, turnIndex, userMessage, assistantMessage, mentalModel) => {
          setEvalMessages(prev => [...prev,
            { id: Date.now() + turnIndex * 2, role: 'user', content: userMessage, timestamp: new Date() },
            { id: Date.now() + turnIndex * 2 + 1, role: 'assistant', content: assistantMessage, timestamp: new Date() }
          ])
          setEvalMentalModel(mentalModel)
          setEvalMentalModelsByTurn(prev => [...prev, mentalModel])
        },
        onProgress: (runId, sourceId, t, total) => {
          setHumanDataProgress(`Human analysis: turn ${t + 1}/${total}`)
        },
        downloadWhenDone: true,
      })
      setHumanDataStatus(`Done. ${result.runId}. ZIP downloaded. Up to turn ${result.meta.turns_recorded_up_to + 1}.`)
      setHumanDataProgress('')
    } catch (err) {
      console.error('Human data analysis error:', err)
      setHumanDataStatus(`Error: ${err.message}`)
      setHumanDataProgress('')
    }
  }

  const handleHumanDataResumeFile = (e) => {
    const file = e.target?.files?.[0]
    if (!file) return
    setHumanDataResumeFileName(file.name)
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const json = JSON.parse(reader.result)
        if (json?.meta && Array.isArray(json.turns)) {
          setHumanDataResumeJson(json)
        } else {
          setHumanDataResumeJson(null)
        }
      } catch {
        setHumanDataResumeJson(null)
      }
    }
    reader.readAsText(file)
  }

  const clearResumeFile = () => {
    setHumanDataResumeJson(null)
    setHumanDataResumeFileName(null)
  }

  const handleHumanDataSourceFile = (e) => {
    const file = e.target?.files?.[0]
    if (!file) return
    setHumanDataUploadedFileName(file.name)
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const json = JSON.parse(reader.result)
        if (json?.messages?.length) {
          setHumanDataUploadedJson(json)
        } else {
          setHumanDataUploadedJson(null)
        }
      } catch {
        setHumanDataUploadedJson(null)
      }
    }
    reader.readAsText(file)
  }

  const clearSourceFile = () => {
    setHumanDataUploadedJson(null)
    setHumanDataUploadedFileName(null)
  }

  const evalRunning = evalTestStatus === 'running' || evalFullStatus === 'running' || humanDataStatus === 'running'

  return (
    <div className="app">
      <div className="app-tabs">
        <button
          type="button"
          className={`app-tab ${viewMode === 'chat' ? 'app-tab-active' : ''}`}
          onClick={() => setViewMode('chat')}
        >
          Run conversations
        </button>
        <button
          type="button"
          className={`app-tab ${viewMode === 'explore' ? 'app-tab-active' : ''}`}
          onClick={() => setViewMode('explore')}
        >
          Explore conversations
        </button>
      </div>
      {viewMode === 'explore' ? (
        <div className="app-explore-wrap">
          <ExploreConversations onClose={() => setViewMode('chat')} />
        </div>
      ) : (
        <div className="app-chat-layout">
      <div className="app-controls">
        <section className="control-section">
          <h3 className="control-section-title">Model & API</h3>
          <label className="control-row">
            <span className="control-label">Mental model</span>
            <select
              value={mentalModelType}
              onChange={(e) => setMentalModelType(e.target.value)}
              disabled={evalRunning}
              className="control-select"
            >
              <option value="induct">Induct</option>
              <option value="types_support">Support</option>
              <option value="structured">Structured</option>
              <option value="person_perception">Person perception (experimental)</option>
            </select>
          </label>
          <label className="control-row">
            <span className="control-label">API model</span>
            <select
              value={apiProvider}
              onChange={(e) => setApiProviderState(e.target.value)}
              disabled={evalRunning}
              className="control-select"
            >
              <option value="gpt-4o">GPT-4o (Azure)</option>
              <option value="gemini">Gemini</option>
              <option value="llama">Llama (Vertex)</option>
            </select>
          </label>
          <label className="control-row control-row-checkbox">
            <input
              type="checkbox"
              checked={separateMentalModelResponse}
              onChange={(e) => setSeparateMentalModelResponse(e.target.checked)}
              disabled={evalRunning}
              className="control-checkbox"
            />
            <span className="control-label-inline">Separate mental model + response</span>
          </label>
          <label className="control-row control-row-checkbox" title={mentalModelType === 'induct' || mentalModelType === 'types_support' ? '' : 'Only for Induct or Support'}>
            <input
              type="checkbox"
              checked={usePrior}
              onChange={(e) => setUsePrior(e.target.checked)}
              disabled={evalRunning || (mentalModelType !== 'induct' && mentalModelType !== 'types_support')}
              className="control-checkbox"
            />
            <span className="control-label-inline">Prior (scores from previous turn)</span>
          </label>
        </section>

        <section className="control-section control-section-collapsible">
          <details className="control-details">
            <summary className="control-details-summary">Run simulated eval</summary>
            <div className="control-details-content">
              <p className="control-section-desc">30×20 turns (or test 1). From <a href="https://eqbench.com/spiral-bench.html" target="_blank" rel="noopener noreferrer" className="control-link">Spiral-Bench</a>.</p>
              <div className="control-row">
                <button type="button" onClick={runEvalTest} disabled={evalRunning} className="control-btn control-btn-test">
                  {evalTestStatus === 'running' ? 'Running…' : 'Test eval (1×20)'}
                </button>
              </div>
              <label className="control-row">
                <span className="control-label">Start from scenario</span>
                <input
                  type="number"
                  min={1}
                  max={30}
                  value={startFromScenario}
                  onChange={(e) => setStartFromScenario(Math.min(30, Math.max(1, parseInt(e.target.value, 10) || 1)))}
                  disabled={evalRunning}
                  className="control-input"
                />
              </label>
              <label className="control-row">
                <span className="control-label">Eval seed</span>
                <input
                  type="number"
                  value={evalSeed}
                  onChange={(e) => {
                    const n = parseInt(e.target.value, 10)
                    setEvalSeed(Number.isNaN(n) ? 42 : n)
                  }}
                  disabled={evalRunning}
                  className="control-input"
                />
              </label>
              <div className="control-row">
                <button type="button" onClick={runEvalFull} disabled={evalRunning} className="control-btn control-btn-full">
                  {evalFullStatus === 'running' ? 'Running full eval…' : 'Run full eval (30×20)'}
                </button>
              </div>
              {evalTestStatus && evalTestStatus !== 'running' && <div className="control-status">{evalTestStatus}</div>}
              {evalFullStatus && evalFullStatus !== 'running' && <div className="control-status">{evalFullStatus}</div>}
              {evalFullProgress && <div className="control-progress">{evalFullProgress}</div>}
            </div>
          </details>
        </section>

        <section className="control-section control-section-collapsible">
          <details className="control-details">
            <summary className="control-details-summary">Run human data</summary>
            <div className="control-details-content">
              <p className="control-section-desc">Mental model analysis for a conversation (JSON).</p>
          <div className="file-upload-row">
            <span className="control-label">Conversation file</span>
            <input
              id="human-data-source-file"
              type="file"
              accept=".json"
              onChange={handleHumanDataSourceFile}
              disabled={evalRunning}
              className="file-upload-input"
            />
            <label htmlFor="human-data-source-file" className="file-upload-label">
              {humanDataUploadedFileName ? humanDataUploadedFileName : 'Choose conversation file…'}
            </label>
            {humanDataUploadedFileName && !humanDataUploadedJson && (
              <span className="file-upload-error">Invalid or missing messages</span>
            )}
            {humanDataUploadedJson && (
              <span className="file-upload-meta">{humanDataUploadedJson.messages?.length ?? 0} messages</span>
            )}
            {humanDataUploadedJson && (
              <button type="button" onClick={clearSourceFile} disabled={evalRunning} className="control-btn control-btn-ghost" style={{ marginTop: 4 }}>
                Clear file
              </button>
            )}
          </div>
          <div className="control-row" style={{ marginTop: 16 }}>
            <button type="button" onClick={() => runHumanData()} disabled={evalRunning || !humanDataUploadedJson} className="control-btn control-btn-primary" style={{ width: '100%' }}>
              {humanDataStatus === 'running' ? 'Running…' : 'Run human data analysis'}
            </button>
          </div>

          <div className="control-section-resume">
            <span className="control-label">Resume from checkpoint</span>
            <p className="control-section-desc">Load checkpoint (meta + turns). Click Resume to continue.</p>
            <div className="file-upload-row">
              <input
                id="human-data-resume-file"
                type="file"
                accept=".json"
                onChange={handleHumanDataResumeFile}
                disabled={evalRunning}
                className="file-upload-input"
              />
              <label htmlFor="human-data-resume-file" className="file-upload-label">
                {humanDataResumeFileName ? humanDataResumeFileName : 'Choose checkpoint file…'}
              </label>
              {humanDataResumeJson && (
                <span className="file-upload-meta">
                  {humanDataResumeJson.turns?.length ?? 0} turns · up to turn {(humanDataResumeJson.meta?.turns_recorded_up_to ?? -1) + 1}
                </span>
              )}
              {humanDataResumeFileName && !humanDataResumeJson && (
                <span className="file-upload-error">Invalid or missing meta/turns</span>
              )}
            </div>
            <div className="control-row" style={{ marginTop: 8 }}>
              <button
                type="button"
                onClick={() => runHumanData(humanDataResumeJson)}
                disabled={evalRunning || !humanDataResumeJson}
                className="control-btn control-btn-resume"
                style={{ width: '100%' }}
              >
                Resume from checkpoint
              </button>
              {humanDataResumeJson && (
                <button type="button" onClick={clearResumeFile} disabled={evalRunning} className="control-btn control-btn-ghost" style={{ width: '100%', marginTop: 6 }}>
                  Clear file
                </button>
              )}
            </div>
          </div>
          {humanDataStatus && humanDataStatus !== 'running' && <div className="control-status">{humanDataStatus}</div>}
          {humanDataProgress && <div className="control-progress">{humanDataProgress}</div>}
            </div>
          </details>
        </section>
      </div>
      <ChatInterface 
        messages={evalRunning ? evalMessages : messages}
        onSendMessage={handleSendMessage}
        isLoading={isLoading}
        disableInput={evalRunning}
        title={evalRunning ? `Eval: ${evalScenarioLabel || '…'}` : null}
      />
      <VisualizationPanel 
        assumptions={evalRunning ? null : assumptions}
        assumptionsHistory={evalRunning ? [] : assumptionsHistory}
        mentalModel={evalRunning ? evalMentalModel : mentalModel}
        mentalModelsByTurn={evalRunning ? evalMentalModelsByTurn : mentalModelsByTurn}
        isLoadingMentalModel={evalRunning ? false : isLoadingMentalModel}
        isLoadingAssumptions={isLoadingAssumptions}
        useOldModel={useOldModel}
        mentalModelType={mentalModelType}
      />
        </div>
      )}
    </div>
  )
}

export default App
