import React, { useCallback, useRef, useState } from 'react';
import { uploadDocument, deleteDocument, type Document } from '../api';

interface SidebarProps {
  documents: Document[];
  selectedDoc: Document | null;
  onSelectDoc: (doc: Document) => void;
  onDocumentUploaded: (doc: Document) => void;
  onDocumentDeleted: (id: number) => void;
  onToast: (msg: string, type: 'success' | 'error' | 'info') => void;
  onReturnHome?: () => void;
}

// STATUS_ICONS reserved for status displays

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

export function Sidebar({
  documents,
  selectedDoc,
  onSelectDoc,
  onDocumentUploaded,
  onDocumentDeleted,
  onToast,
  onReturnHome,
}: SidebarProps) {
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(
    async (file: File) => {
      if (!file.name.toLowerCase().endsWith('.pdf')) {
        onToast('Only PDF files are accepted.', 'error');
        return;
      }
      setUploading(true);
      try {
        const doc = await uploadDocument(file);
        onDocumentUploaded(doc);
        onToast(`"${file.name}" uploaded. Ingestion started…`, 'info');
      } catch (e: unknown) {
        onToast((e as Error).message || 'Upload failed', 'error');
      } finally {
        setUploading(false);
      }
    },
    [onDocumentUploaded, onToast]
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile]
  );

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
    e.target.value = '';
  };

  const handleDelete = async (e: React.MouseEvent, doc: Document) => {
    e.stopPropagation();
    if (!confirm(`Delete "${doc.original_name}"?`)) return;
    try {
      await deleteDocument(doc.id);
      onDocumentDeleted(doc.id);
      onToast('Document deleted.', 'success');
    } catch {
      onToast('Failed to delete document.', 'error');
    }
  };

  return (
    <aside className="sidebar">
      {/* Header / Logo */}
      <div className="sidebar-header">
        <div
          className="logo"
          onClick={onReturnHome}
          style={onReturnHome ? { cursor: 'pointer' } : undefined}
          title={onReturnHome ? "Click to return to Home Screen" : undefined}
          role={onReturnHome ? "button" : undefined}
          tabIndex={onReturnHome ? 0 : undefined}
          onKeyDown={onReturnHome ? (e) => { if (e.key === 'Enter' || e.key === ' ') onReturnHome(); } : undefined}
        >
          <div className="logo-icon">🎙️</div>
          <div>
            <div className="logo-text">AutoNotes AI</div>
            <span className="logo-sub">Document Intelligence</span>
          </div>
        </div>

        {/* Upload Zone */}
        <div
          className={`upload-zone${dragging ? ' drag-over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => fileInputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && fileInputRef.current?.click()}
          aria-label="Upload PDF document"
        >
          <span className="upload-icon">
            {uploading ? '⏳' : dragging ? '📂' : '📄'}
          </span>
          {uploading ? (
            <p>Uploading…</p>
          ) : (
            <>
              <p><strong>Drop PDF here</strong></p>
              <p>or click to browse</p>
            </>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf"
            style={{ display: 'none' }}
            onChange={onFileChange}
            id="pdf-file-input"
          />
        </div>
      </div>

      {/* Document List */}
      <div className="doc-list">
        <div className="doc-list-title">
          Documents ({documents.length})
        </div>

        {documents.length === 0 && (
          <div style={{ padding: '16px 4px', color: 'var(--text-muted)', fontSize: '13px' }}>
            No documents yet. Upload a PDF to get started.
          </div>
        )}

        {documents.map((doc) => (
          <div
            key={doc.id}
            className={`doc-item${selectedDoc?.id === doc.id ? ' active' : ''}`}
            onClick={() => onSelectDoc(doc)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && onSelectDoc(doc)}
          >
            <div className="doc-item-name" title={doc.original_name}>
              📑 {doc.original_name}
            </div>
            <div className="doc-item-meta">
              <StatusBadge status={doc.status} />
              <span>{formatBytes(doc.file_size)}</span>
              {doc.page_count > 0 && <span>{doc.page_count}p</span>}
              {doc.chunk_count > 0 && <span>{doc.chunk_count} chunks</span>}
              <button
                onClick={(e) => handleDelete(e, doc)}
                style={{
                  marginLeft: 'auto',
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-muted)',
                  cursor: 'pointer',
                  fontSize: '14px',
                  padding: '2px 6px',
                  borderRadius: '4px',
                  transition: 'color 0.2s',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--status-error)')}
                onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-muted)')}
                aria-label={`Delete ${doc.original_name}`}
                title="Delete document"
              >
                🗑
              </button>
            </div>
            {doc.status === 'error' && doc.error_message && (
              <div style={{ fontSize: '11px', color: 'var(--status-error)', marginTop: '6px' }}>
                {doc.error_message}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Footer */}
      <div style={{ padding: '16px 20px', borderTop: '1px solid var(--glass-border)' }}>
        <div className="provider-badge">✨ AI-Powered RAG</div>
      </div>
    </aside>
  );
}

function StatusBadge({ status }: { status: string }) {
  const isPulsing = status === 'ingesting' || status === 'uploading';
  return (
    <span className={`status-badge ${status}`}>
      <span className={`status-dot${isPulsing ? ' pulse' : ''}`} />
      {status === 'ready' ? 'Ready' : status === 'ingesting' ? 'Indexing' : status === 'uploading' ? 'Uploading' : 'Error'}
    </span>
  );
}
