import { useState, useRef, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import './ChatInterface.css'

function ChatInterface({ messages, onSendMessage, isLoading, disableInput = false, title = null }) {
  const [input, setInput] = useState('')
  const messagesEndRef = useRef(null)

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages])

  const handleSubmit = (e) => {
    e.preventDefault()
    if (input.trim() && !isLoading && !disableInput) {
      onSendMessage(input.trim())
      setInput('')
    }
  }

  const inputDisabled = isLoading || disableInput

  return (
    <div className="chat-interface">
      {title && (
        <div className="chat-title" style={{ padding: '6px 10px', background: '#e8e8e8', fontSize: '13px', fontWeight: 600 }}>
          {title}
        </div>
      )}
      <div className="chat-messages">
        {messages.length === 0 && !title && (
          <div className="empty-state">
            <p>Start a conversation with the LLM</p>
          </div>
        )}
        {messages.length === 0 && title && (
          <div className="empty-state">
            <p>Eval running… conversation will appear here.</p>
          </div>
        )}
        
        {messages.map((message) => (
          <div key={message.id} className={`message ${message.role}`}>
            <div className="message-content">
              <div className="message-text">
                {message.role === 'assistant' ? (
                  <ReactMarkdown>{message.content}</ReactMarkdown>
                ) : (
                  message.content
                )}
              </div>
            </div>
          </div>
        ))}
        
        {isLoading && (
          <div className="message assistant">
            <div className="message-content">
              <div className="message-text">
                <span className="typing-indicator">Thinking...</span>
              </div>
            </div>
          </div>
        )}
        
        <div ref={messagesEndRef} />
      </div>

      <form className="chat-input-form" onSubmit={handleSubmit}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={disableInput ? 'Eval running…' : 'Type your message...'}
          disabled={inputDisabled}
          className="chat-input"
        />
        <button 
          type="submit" 
          disabled={!input.trim() || inputDisabled}
          className="send-button"
        >
          Send
        </button>
      </form>
    </div>
  )
}

export default ChatInterface
