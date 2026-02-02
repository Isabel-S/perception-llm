import { useState } from 'react'
import ChatInterface from './components/ChatInterface'
import VisualizationPanel from './components/VisualizationPanel'
import { sendMessageToLLM, inferUncertainAssumptions, inferMentalModel, inferMentalModelOld } from './services/api'
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
  const [useOldModel, setUseOldModel] = useState(false) // Toggle for old vs new model
  const [memory, setMemory] = useState({ turn_index: [] }) // Memory for new model

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

      // Infer mental model from user message on every turn (unlocked, but read-only)
      // Run in background, don't block UI
      setIsLoadingMentalModel(true)
      const turnId = `t${String(turnIndex).padStart(3, '0')}`
      
      // Choose which model to use based on toggle
      const modelPromise = useOldModel
        ? inferMentalModelOld(message)
        : inferMentalModel(message, turnId, memory)
      
      modelPromise
        .then(mmData => {
          setMentalModel(mmData)
          setIsLoadingMentalModel(false)
          
          // Update memory for new model (use full memory: situation_log + turn_index)
          if (!useOldModel && mmData.memory) {
            setMemory(mmData.memory)
          }
        })
        .catch(mmError => {
          console.error('Error inferring mental model:', mmError)
          setIsLoadingMentalModel(false)
        })

      // Call Azure OpenAI API for response
      const response = await sendMessageToLLM(message, conversationHistory)
      
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

  return (
    <div className="app">
      <ChatInterface 
        messages={messages}
        onSendMessage={handleSendMessage}
        isLoading={isLoading}
      />
      <VisualizationPanel 
        assumptions={assumptions}
        assumptionsHistory={assumptionsHistory}
        mentalModel={mentalModel}
        isLoadingMentalModel={isLoadingMentalModel}
        isLoadingAssumptions={isLoadingAssumptions}
        useOldModel={useOldModel}
        onToggleModel={() => setUseOldModel(!useOldModel)}
      />
    </div>
  )
}

export default App
