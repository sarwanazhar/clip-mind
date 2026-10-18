-- Migration 0002: Add TypeSafe JEV-1.14.0 structured evaluation columns & update status constraint
PRAGMA foreign_keys=off;

CREATE TABLE IF NOT EXISTS documents_new (
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

INSERT INTO documents_new (
  id, url, source, title, author, summary, 
  r2_snapshot_key, r2_screenshot_key, word_count, created_at, status
)
SELECT 
  id, url, source, title, author, summary, 
  r2_snapshot_key, r2_screenshot_key, word_count, created_at, status 
FROM documents;

DROP TABLE documents;

ALTER TABLE documents_new RENAME TO documents;

CREATE INDEX IF NOT EXISTS idx_docs_status ON documents(status);

PRAGMA foreign_keys=on;
