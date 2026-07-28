import React, { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getChatHistory, sendChatMessageStream, type ChatMessage, type Document, type SourceChunk } from '../api';

interface ChatSectionProps {
  document: Document;
  onToast: (msg: string, type: 'success' | 'error' | 'info') => void;
}

interface LocalMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  sources: SourceChunk[];
}

let localIdCounter = 1;

export function ChatSection({ document, onToast }: ChatSectionProps) {
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [openSources, setOpenSources] = useState<Set<number>>(new Set());
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [isListening, setIsListening] = useState(false);
  const srRef = useRef<any>(null);

  const toggleVoiceInput = () => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      onToast("Speech recognition is not supported in this browser.", "error");
      return;
    }
    if (isListening) {
      try { srRef.current?.abort(); } catch {}
      setIsListening(false);
      return;
    }
    const r = new SR();
    r.continuous = false;
    r.interimResults = true;
    r.lang = navigator.language || "en-US";
    let transcript = "";
    r.onresult = (e: any) => {
      let full = "";
      for (let i = 0; i < e.results.length; i++) {
        full += e.results[i][0].transcript + " ";
      }
      transcript = full.trim();
      setInput(transcript);
    };
    r.onend = () => {
      setIsListening(false);
      if (transcript.trim()) {
        onToast(`Registered question: "${transcript}"`, "success");
      }
    };
    r.onerror = () => {
      setIsListening(false);
      onToast("Voice input error. Please try speaking again.", "error");
    };
    try {
      r.start();
      srRef.current = r;
      setIsListening(true);
      onToast("🎤 Microphone Active — Speak your question...", "info");
    } catch {
      setIsListening(false);
    }
  };

  // Load chat history when document changes
  useEffect(() => {
    setMessages([]);
    setHistoryLoaded(false);
    setOpenSources(new Set());

    if (document.status !== 'ready') return;

    getChatHistory(document.id)
      .then((history: ChatMessage[]) => {
        const mapped: LocalMessage[] = history.map((m) => ({
          id: localIdCounter++,
          role: m.role,
          content: m.content,
          sources: m.sources || [],
        }));
        setMessages(mapped);
      })
      .catch(() => {})
      .finally(() => setHistoryLoaded(true));
  }, [document.id, document.status]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  const handleSend = useCallback(async () => {
    const q = input.trim();
    if (!q || loading) return;

    const userMsg: LocalMessage = { id: localIdCounter++, role: 'user', content: q, sources: [] };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setLoading(true);

    // Auto-resize textarea reset
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    const assistantId = localIdCounter++;

    try {
      let assistantMsg: LocalMessage | null = null;

      await sendChatMessageStream(document.id, q, (event) => {
        if (event.type === 'sources') {
          assistantMsg = {
            id: assistantId,
            role: 'assistant',
            content: '',
            sources: event.sources,
          };
          setMessages((prev) => [...prev, assistantMsg!]);
        } else if (event.type === 'chunk') {
          if (!assistantMsg) {
            // If we got a chunk before sources (edge case), create the assistant msg now
            assistantMsg = {
              id: assistantId,
              role: 'assistant',
              content: event.text,
              sources: [],
            };
            setMessages((prev) => [...prev, assistantMsg!]);
          } else {
            assistantMsg = { ...assistantMsg, content: assistantMsg.content + event.text };
            setMessages((prev) => prev.map((m) => m.id === assistantId ? assistantMsg! : m));
          }
        }
      });
    } catch (e: unknown) {
      const errMsg = (e instanceof Error ? e.message : String(e)) || 'Chat failed';
      onToast(errMsg, 'error');
      // Remove the user message if no assistant response was added
      setMessages((prev) => {
        const hasAssistant = prev.some((m) => m.id === assistantId);
        if (hasAssistant) return prev; // Keep both if assistant already responded
        return prev.filter((m) => m.id !== userMsg.id); // Remove only the user message
      });
    } finally {
      setLoading(false);
      // Re-focus the input so user can immediately type another question
      setTimeout(() => textareaRef.current?.focus(), 50);
    }
  }, [input, loading, document.id, onToast]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    // Auto-resize
    e.target.style.height = 'auto';
    e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
  };

  const toggleSources = (id: number) => {
    setOpenSources((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (document.status !== 'ready') {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">
          {document.status === 'ingesting' ? '⚙️' : document.status === 'uploading' ? '📤' : '⚠️'}
        </div>
        <h2>
          {document.status === 'ingesting'
            ? 'Building Knowledge Index…'
            : document.status === 'uploading'
            ? 'Uploading Document…'
            : 'Processing Error'}
        </h2>
        <p>
          {document.status === 'error'
            ? document.error_message || 'An error occurred during ingestion.'
            : 'Please wait while we process your document. This may take a moment.'}
        </p>
        {(document.status === 'ingesting' || document.status === 'uploading') && (
          <div className="spinner" style={{ marginTop: 8 }} />
        )}
      </div>
    );
  }

  return (
    <div className="chat-section">
      {/* Messages */}
      <div className="chat-messages">
        {messages.length === 0 && historyLoaded && (
          <div className="empty-state" style={{ padding: '20px' }}>
            <div className="empty-state-icon">💬</div>
            <h2>Start a Conversation</h2>
            <p>Ask anything about <strong style={{ color: 'var(--accent-purple)' }}>{document.original_name}</strong>. I'll find the most relevant sections and answer precisely.</p>

            {/* Suggested questions */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', justifyContent: 'center', marginTop: '8px' }}>
              {[
                'What is the main topic of this document?',
                'Summarize the key findings',
                'What are the conclusions?',
                'List the main concepts discussed',
              ].map((suggestion) => (
                <button
                  key={suggestion}
                  onClick={() => { setInput(suggestion); textareaRef.current?.focus(); }}
                  style={{
                    background: 'rgba(139, 92, 246, 0.1)',
                    border: '1px solid rgba(139, 92, 246, 0.25)',
                    borderRadius: '20px',
                    padding: '8px 16px',
                    color: 'var(--accent-purple)',
                    fontSize: '12px',
                    cursor: 'pointer',
                    fontFamily: 'Inter, sans-serif',
                    transition: 'all 0.2s',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(139, 92, 246, 0.2)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(139, 92, 246, 0.1)'; }}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <div key={msg.id} className={`message-bubble ${msg.role}`}>
            <div className="message-avatar">
              {msg.role === 'user' ? '👤' : '🤖'}
            </div>
            <div>
              <div className="message-content">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {msg.content}
                </ReactMarkdown>
              </div>

              {msg.role === 'assistant' && msg.sources.length > 0 && (
                <>
                  <button
                    className="sources-toggle"
                    onClick={() => toggleSources(msg.id)}
                  >
                    {openSources.has(msg.id) ? '▲ Hide' : '▼ Show'} {msg.sources.length} source{msg.sources.length > 1 ? 's' : ''}
                  </button>

                  {openSources.has(msg.id) && (
                    <div className="sources-panel">
                      {msg.sources.map((src, i) => (
                        <div key={i} className="source-chip">
                          <span className="source-score">Score: {src.score.toFixed(3)}</span>
                          <br />
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {src.chunk}
                          </ReactMarkdown>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        ))}

        {/* Typing indicator */}
        {loading && messages.length > 0 && messages[messages.length - 1].role === 'user' && (
          <div className="message-bubble assistant">
            <div className="message-avatar">🤖</div>
            <div className="message-content">
              <div className="typing-indicator">
                <div className="typing-dot" />
                <div className="typing-dot" />
                <div className="typing-dot" />
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <div className="chat-input-area">
        <div className="chat-input-wrapper" style={{ alignItems: "center" }}>
          <textarea
            ref={textareaRef}
            className="chat-input"
            placeholder={`Ask anything about ${document.original_name}… (Enter to send, Shift+Enter for newline)`}
            value={input}
            onChange={handleTextareaChange}
            onKeyDown={handleKeyDown}
            rows={1}
            id="chat-input-textarea"
          />

          {/* Microphone voice input button */}
          <button
            type="button"
            className={`voice-mic-btn${isListening ? " listening" : ""}`}
            onClick={toggleVoiceInput}
            title={isListening ? "Listening... click to stop" : "Click to speak your question via microphone"}
            aria-label="Voice input microphone"
            style={{
              background: isListening ? "rgba(239, 68, 68, 0.2)" : "rgba(139, 92, 246, 0.15)",
              border: isListening ? "1px solid #ef4444" : "1px solid rgba(139, 92, 246, 0.3)",
              color: isListening ? "#ef4444" : "var(--accent-purple-light, #c084fc)",
              borderRadius: "50%",
              width: "38px",
              height: "38px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              fontSize: "16px",
              flexShrink: 0,
              transition: "all 0.2s ease",
            }}
          >
            {isListening ? "🔴" : "🎙️"}
          </button>

          <button
            className="send-btn"
            onClick={handleSend}
            disabled={loading || !input.trim()}
            aria-label="Send message"
            title="Send message"
          >
            ➤
          </button>
        </div>
      </div>
    </div>
  );
}
