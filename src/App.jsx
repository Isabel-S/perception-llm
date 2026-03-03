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
  const [mentalModelType, setMentalModelType] = useState('person_perception') // 'person_perception' | 'support' | 'induct' | 'structured' | 'types_support'
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
  const [evalScenarioLabel, setEvalScenarioLabel] = useState('')
  const [evalSeekerPrompt, setEvalSeekerPrompt] = useState({ default: '', categoryInjection: '', extraInjection: '' })
  const [viewMode, setViewMode] = useState('chat') // 'chat' | 'explore'
  const [humanDataPath, setHumanDataPath] = useState('do_not_upload/h01.json')
  const [humanDataStatus, setHumanDataStatus] = useState(null)
  const [humanDataProgress, setHumanDataProgress] = useState('')
  const [humanDataResumeJson, setHumanDataResumeJson] = useState(null)
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
      setHumanDataStatus('Error: Human data analysis only supports Induct or Types support.')
      return
    }
    setHumanDataStatus('running')
    setEvalMessages([])
    setEvalScenarioLabel(`Human: ${humanDataPath}`)
    setHumanDataProgress('')
    try {
      const result = await runHumanDataAnalysis({
        dataPath: humanDataPath.trim() || 'do_not_upload/h01.json',
        mentalModelType,
        usePrior,
        existingResult: resumeFrom ?? undefined,
        onTurn: (runId, sourceId, turnIndex, userMessage, assistantMessage, mentalModel) => {
          setEvalMessages(prev => [...prev,
            { id: Date.now() + turnIndex * 2, role: 'user', content: userMessage, timestamp: new Date() },
            { id: Date.now() + turnIndex * 2 + 1, role: 'assistant', content: assistantMessage, timestamp: new Date() }
          ])
          setEvalMentalModel(mentalModel)
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

  const evalRunning = evalTestStatus === 'running' || evalFullStatus === 'running' || humanDataStatus === 'running'

  return (
    <div className="app">
      {viewMode === 'explore' ? (
        <div className="app-explore-wrap">
          <ExploreConversations onClose={() => setViewMode('chat')} />
        </div>
      ) : (
        <div className="app-chat-layout">
      <div className="app-controls">
        <div className="control-row">
          <button
            type="button"
            onClick={() => setViewMode('explore')}
            className="control-btn control-btn-explore"
            disabled={evalRunning}
          >
            Explore conversations
          </button>
        </div>
        <label className="control-row">
          <span className="control-label">Mental model</span>
          <select
            value={mentalModelType}
            onChange={(e) => setMentalModelType(e.target.value)}
            disabled={evalRunning}
            className="control-select"
          >
            <option value="person_perception">Person perception</option>
            {/* <option value="support">Support</option> */}
            <option value="induct">Induct</option>
            <option value="structured">Structured</option>
            <option value="types_support">Types support</option>
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
        <label className="control-row control-row-checkbox" title={mentalModelType === 'induct' || mentalModelType === 'types_support' ? '' : 'Only for Induct or Types support'}>
          <input
            type="checkbox"
            checked={usePrior}
            onChange={(e) => setUsePrior(e.target.checked)}
            disabled={evalRunning || (mentalModelType !== 'induct' && mentalModelType !== 'types_support')}
            className="control-checkbox"
          />
          <span className="control-label-inline">Prior (previous turn mental model, scores only)</span>
        </label>
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
        <div className="control-row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <span className="control-label">Human data (induct/types_support):</span>
          <input
            type="text"
            value={humanDataPath}
            onChange={(e) => setHumanDataPath(e.target.value)}
            disabled={evalRunning}
            placeholder="do_not_upload/h01.json"
            className="control-input"
            style={{ minWidth: 180 }}
          />
          <button type="button" onClick={() => runHumanData()} disabled={evalRunning} className="control-btn">
            {humanDataStatus === 'running' ? 'Running…' : 'Run human data analysis'}
          </button>
        </div>
        <div className="control-row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <label className="control-label-inline" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="file" accept=".json" onChange={handleHumanDataResumeFile} disabled={evalRunning} />
            Load previous result
          </label>
          <button type="button" onClick={() => runHumanData(humanDataResumeJson)} disabled={evalRunning || !humanDataResumeJson} className="control-btn">
            Resume human data analysis
          </button>
        </div>
        {humanDataStatus && humanDataStatus !== 'running' && <div className="control-status">{humanDataStatus}</div>}
        {humanDataProgress && <div className="control-progress">{humanDataProgress}</div>}
        {evalTestStatus && evalTestStatus !== 'running' && <div className="control-status">{evalTestStatus}</div>}
        {evalFullStatus && evalFullStatus !== 'running' && <div className="control-status">{evalFullStatus}</div>}
        {evalFullProgress && <div className="control-progress">{evalFullProgress}</div>}
      </div>
      {evalRunning && (evalSeekerPrompt.default || evalSeekerPrompt.categoryInjection || evalSeekerPrompt.extraInjection) && (
        <div style={{ padding: '10px', background: '#f9f9f9', borderBottom: '1px solid #ddd', fontSize: '12px' }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Seeker prompt for this scenario:</div>
          {evalSeekerPrompt.default && (
            <div style={{ marginBottom: 8, whiteSpace: 'pre-wrap' }}>{evalSeekerPrompt.default}</div>
          )}
          {evalSeekerPrompt.categoryInjection && (
            <div style={{ marginBottom: 4, padding: '4px 8px', background: '#e3f2fd', borderRadius: 4, color: '#1565c0', fontWeight: 500 }}>
              <strong>Category injection:</strong> {evalSeekerPrompt.categoryInjection}
            </div>
          )}
          {evalSeekerPrompt.extraInjection && (
            <div style={{ marginTop: 4, padding: '4px 8px', background: '#fff3e0', borderRadius: 4, color: '#e65100', fontWeight: 500 }}>
              <strong>Extra injection:</strong> {evalSeekerPrompt.extraInjection}
            </div>
          )}
        </div>
      )}
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
