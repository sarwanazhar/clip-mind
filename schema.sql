-- Base Schema for ClipMind (Consolidated with JEV Structured Evaluation)

-- Master Document Record
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('web', 'discord', 'bookmarklet')),
  title TEXT,
  author TEXT,
  summary TEXT,
  r2_snapshot_key TEXT,
  r2_screenshot_key TEXT,
  word_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'indexed', 'failed', 'rejected_by_jev')),
  category TEXT DEFAULT 'uncategorized',
  quality_score REAL DEFAULT 0.0,
  tldr_json TEXT,
  jev_verified INTEGER DEFAULT 0,
  rejection_reason TEXT
);

-- Text Chunks for 384-Dim Vector Embeddings
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  token_count INTEGER NOT NULL,
  vector_id TEXT NOT NULL UNIQUE,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS document_tags (
  document_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  PRIMARY KEY (document_id, tag_id),
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_docs_status ON documents(status);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_chunks_vector ON chunks(vector_id);
