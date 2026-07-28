// API client for AutoNotes AI backend

const API_BASE = 'http://localhost:8000/api';

export interface Document {
  id: number;
  original_name: string;
  file_size: number;
  page_count: number;
  chunk_count: number;
  status: 'uploading' | 'ingesting' | 'ready' | 'error';
  error_message?: string;
  created_at: string;
}

export interface ChatMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  sources: SourceChunk[];
  created_at: string;
}

export interface SourceChunk {
  chunk: string;
  score: number;
}

export interface ChatResponse {
  answer: string;
  sources: SourceChunk[];
  message_id: number;
}

export interface Podcast {
  id: number;
  document_id: number;
  status: 'generating' | 'ready' | 'error';
  script?: string;
  duration_seconds: number;
  error_message?: string;
  created_at: string;
}

export interface ScriptLine {
  host: 'A' | 'B';
  text: string;
}

// ─── Documents ────────────────────────────────────────────────────────────

export async function uploadDocument(file: File): Promise<Document> {
  const formData = new FormData();
  formData.append('file', file);

  const res = await fetch(`${API_BASE}/documents/upload`, {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Upload failed' }));
    throw new Error(err.detail || 'Upload failed');
  }

  return res.json();
}

export async function listDocuments(): Promise<Document[]> {
  const res = await fetch(`${API_BASE}/documents`);
  if (!res.ok) throw new Error('Failed to fetch documents');
  return res.json();
}

export async function getDocument(id: number): Promise<Document> {
  const res = await fetch(`${API_BASE}/documents/${id}`);
  if (!res.ok) throw new Error('Document not found');
  return res.json();
}

export async function deleteDocument(id: number): Promise<void> {
  const res = await fetch(`${API_BASE}/documents/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete document');
}

// ─── Chat ──────────────────────────────────────────────────────────────────

export async function sendChatMessageStream(
  documentId: number,
  question: string,
  onEvent: (event: any) => void
): Promise<void> {
  const res = await fetch(`${API_BASE}/documents/${documentId}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Chat failed' }));
    throw new Error(err.detail || 'Chat failed');
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error('No readable stream');
  
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    
    // Keep the last partial line in the buffer
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.trim()) {
        try {
          const event = JSON.parse(line);
          onEvent(event);
        } catch (e) {
          console.error('Failed to parse NDJSON line', line);
        }
      }
    }
  }

  if (buffer.trim()) {
    try {
      const event = JSON.parse(buffer.trim());
      onEvent(event);
    } catch (e) {
      /* ignore trailing partial bytes */
    }
  }
}

export async function getChatHistory(documentId: number): Promise<ChatMessage[]> {
  const res = await fetch(`${API_BASE}/documents/${documentId}/chat/history`);
  if (!res.ok) throw new Error('Failed to fetch chat history');
  return res.json();
}

// ─── Blind Companion / Accessibility Chat ─────────────────────────────────────

export async function sendBlindChatStream(
  documentId: number,
  question: string,
  onEvent: (event: any) => void
): Promise<void> {
  const res = await fetch(`${API_BASE}/documents/${documentId}/blind-chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Chat failed' }));
    throw new Error(err.detail || 'Chat failed');
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error('No readable stream');

  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (line.trim()) {
        try { onEvent(JSON.parse(line)); } catch { /* skip bad lines */ }
      }
    }
  }

  if (buffer.trim()) {
    try { onEvent(JSON.parse(buffer.trim())); } catch { /* skip bad lines */ }
  }
}

export async function sendGlobalSearchStream(
  query: string,
  mode: 'question' | 'summary',
  onEvent: (event: any) => void
): Promise<void> {
  const res = await fetch(`${API_BASE}/global-search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, mode }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Global search failed' }));
    throw new Error(err.detail || 'Global search failed');
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error('No readable stream');

  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (line.trim()) {
        try { onEvent(JSON.parse(line)); } catch { /* skip bad lines */ }
      }
    }
  }
}

// ─── Podcasts ──────────────────────────────────────────────────────────────

export async function createPodcast(documentId: number): Promise<Podcast> {
  const res = await fetch(`${API_BASE}/documents/${documentId}/podcast`, {
    method: 'POST',
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Podcast generation failed' }));
    throw new Error(err.detail || 'Podcast generation failed');
  }

  return res.json();
}

export async function listPodcasts(documentId: number): Promise<Podcast[]> {
  const res = await fetch(`${API_BASE}/documents/${documentId}/podcasts`);
  if (!res.ok) throw new Error('Failed to fetch podcasts');
  return res.json();
}

export async function getPodcast(podcastId: number): Promise<Podcast> {
  const res = await fetch(`${API_BASE}/podcasts/${podcastId}`);
  if (!res.ok) throw new Error('Podcast not found');
  return res.json();
}

export function getPodcastAudioUrl(podcastId: number): string {
  return `${API_BASE}/podcasts/${podcastId}/audio`;
}

// ─── Explainer Videos ─────────────────────────────────────────────────────

export interface ExplainerSegment {
  segment: number;
  text: string;
  visual_cue: 'intro' | 'explain' | 'define' | 'example' | 'summary' | 'signoff';
  keywords: string[];
  /** Exact audio start time in seconds (set by backend during generation). */
  start_time?: number;
}

export interface Explainer {
  id: number;
  document_id: number;
  status: 'generating' | 'ready' | 'error';
  domain?: string;
  persona_name?: string;
  persona_type?: string;
  persona_emoji?: string;
  script?: string; // JSON string of ExplainerSegment[]
  duration_seconds: number;
  error_message?: string;
  created_at: string;
}

export async function createExplainer(documentId: number): Promise<Explainer> {
  const res = await fetch(`${API_BASE}/documents/${documentId}/explainer`, {
    method: 'POST',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Explainer generation failed' }));
    throw new Error(err.detail || 'Explainer generation failed');
  }
  return res.json();
}

export async function listExplainers(documentId: number): Promise<Explainer[]> {
  const res = await fetch(`${API_BASE}/documents/${documentId}/explainers`);
  if (!res.ok) throw new Error('Failed to fetch explainers');
  return res.json();
}

export async function getExplainer(explainerId: number): Promise<Explainer> {
  const res = await fetch(`${API_BASE}/explainers/${explainerId}`);
  if (!res.ok) throw new Error('Explainer not found');
  return res.json();
}

export function getExplainerAudioUrl(explainerId: number): string {
  return `${API_BASE}/explainers/${explainerId}/audio`;
}
