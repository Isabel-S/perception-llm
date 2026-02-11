import { useState } from 'react'
import ChatInterface from './components/ChatInterface'
import VisualizationPanel from './components/VisualizationPanel'
import { sendMessageToLLM, sendMessageWithInlineMentalModel, inferUncertainAssumptions, inferMentalModel, inferMentalModelOld, run_simulations } from './services/api'
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
  const [mentalModelType, setMentalModelType] = useState('person_perception') // 'person_perception' | 'old_model' | 'support' | 'induct' | 'structured'
  const useOldModel = mentalModelType === 'old_model'
  const [memory, setMemory] = useState({ turn_index: [] }) // Memory for new model
  const [evalTestStatus, setEvalTestStatus] = useState(null)
  const [evalFullStatus, setEvalFullStatus] = useState(null)
  const [evalFullProgress, setEvalFullProgress] = useState('')
  const [startFromScenario, setStartFromScenario] = useState(1)
  const [evalMessages, setEvalMessages] = useState([])
  const [evalMentalModel, setEvalMentalModel] = useState(null)
  const [evalScenarioLabel, setEvalScenarioLabel] = useState('')
  const [evalSeekerPrompt, setEvalSeekerPrompt] = useState({ default: '', categoryInjection: '', extraInjection: '' })

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

      const isInlineMentalModel = ['support', 'induct', 'structured'].includes(mentalModelType)
      setIsLoadingMentalModel(true)
      const turnId = `t${String(turnIndex).padStart(3, '0')}`
      let mmData = null
      let response

      try {
        if (isInlineMentalModel) {
          const result = await sendMessageWithInlineMentalModel(conversationHistory, message, mentalModelType)
          mmData = result.mentalModel
          response = result.response
          setMentalModel(mmData)
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
        numTurns: 20,
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
        numTurns: 20,
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
      })
      setEvalFullStatus(`Done. runId=${result.runId}. ZIP downloaded.`)
      setEvalFullProgress('')
    } catch (err) {
      console.error('Full eval error:', err)
      setEvalFullStatus(`Error: ${err.message}`)
      setEvalFullProgress('')
    }
  }

  const evalRunning = evalTestStatus === 'running' || evalFullStatus === 'running'

  return (
    <div className="app">
      <div style={{ padding: '8px', background: '#f0f0f0', fontSize: '12px' }}>
        <label style={{ marginRight: 8 }}>
          Mental model:
          <select
            value={mentalModelType}
            onChange={(e) => setMentalModelType(e.target.value)}
            disabled={evalRunning}
            style={{ marginLeft: 4 }}
          >
            <option value="person_perception">Person perception</option>
            <option value="old_model">Old model</option>
            <option value="support">Support</option>
            <option value="induct">Induct</option>
            <option value="structured">Structured</option>
          </select>
        </label>
        <button type="button" onClick={runEvalTest} disabled={evalRunning}>
          {evalTestStatus === 'running' ? 'Running…' : 'Test eval (1×20)'}
        </button>
        <label style={{ marginLeft: 8 }}>
          Start from scenario:
          <input
            type="number"
            min={1}
            max={30}
            value={startFromScenario}
            onChange={(e) => setStartFromScenario(Math.min(30, Math.max(1, parseInt(e.target.value, 10) || 1)))}
            disabled={evalRunning}
            style={{ width: 40, marginLeft: 4 }}
          />
        </label>
        <button type="button" onClick={runEvalFull} disabled={evalRunning} style={{ marginLeft: 8 }}>
          {evalFullStatus === 'running' ? 'Running full eval…' : 'Run full eval (30×20)'}
        </button>
        {evalTestStatus && evalTestStatus !== 'running' && <span style={{ marginLeft: 8 }}>{evalTestStatus}</span>}
        {evalFullStatus && evalFullStatus !== 'running' && <span style={{ marginLeft: 8 }}>{evalFullStatus}</span>}
        {evalFullProgress && <div style={{ marginTop: 4 }}>{evalFullProgress}</div>}
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
  )
}

export default App
