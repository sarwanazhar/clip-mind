import { Hono } from "hono";
import type { WorkflowEnv } from "../workflows/clip-pipeline";

export const dashboardRoute = new Hono<{ Bindings: WorkflowEnv }>();

dashboardRoute.get("/", async (c) => {
  // Query recently clipped documents with JEV metadata and auto-tags from D1
  let documents: Array<{
    id: string;
    url: string;
    source: string;
    title: string | null;
    author: string | null;
    summary: string | null;
    word_count: number;
    created_at: number;
    status: string;
    category: string | null;
    quality_score: number | null;
    tldr_json: string | null;
    jev_verified: number | null;
    rejection_reason: string | null;
    tags_list: string | null;
  }> = [];

  try {
    const res = await c.env.DB.prepare(
      `SELECT 
        d.id, d.url, d.source, d.title, d.author, d.summary, d.word_count, d.created_at, d.status,
        d.category, d.quality_score, d.tldr_json, d.jev_verified, d.rejection_reason,
        GROUP_CONCAT(t.name, ',') as tags_list
       FROM documents d
       LEFT JOIN document_tags dt ON d.id = dt.document_id
       LEFT JOIN tags t ON dt.tag_id = t.id
       GROUP BY d.id
       ORDER BY d.created_at DESC 
       LIMIT 50`
    ).all();
    documents = (res.results as typeof documents) || [];
  } catch (err) {
    console.warn("D1 query warning:", err);
  }

  const origin = new URL(c.req.url).origin;
  const bookmarkletCode = `javascript:(function(){const u=encodeURIComponent(window.location.href);window.open('${origin}/api/clip?url='+u,'_blank');})();`;

  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ClipMind - Edge Web Clipper & Knowledge Vault</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <!-- Markdown Renderer for clean formatted AI chat output -->
  <script src="https://cdn.jsdelivr.net/npm/marked@14.1.2/marked.min.js"></script>
  <style>
    :root {
      --bg: #0b0f19;
      --card-bg: rgba(18, 24, 39, 0.85);
      --card-bg-light: rgba(28, 36, 56, 0.7);
      --border: rgba(255, 255, 255, 0.08);
      --border-accent: rgba(246, 130, 31, 0.3);
      --accent: #f6821f;
      --accent-hover: #fa973e;
      --accent-glow: rgba(246, 130, 31, 0.25);
      --cyan: #00d2ff;
      --cyan-glow: rgba(0, 210, 255, 0.2);
      --text: #f3f4f6;
      --text-muted: #9ca3af;
      --green: #10b981;
      --green-glow: rgba(16, 185, 129, 0.25);
      --yellow: #f59e0b;
      --yellow-glow: rgba(245, 158, 11, 0.25);
      --red: #ef4444;
      --purple: #a855f7;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Plus Jakarta Sans', sans-serif;
      background: radial-gradient(circle at 50% 0%, #17223b 0%, var(--bg) 75%);
      color: var(--text);
      min-height: 100vh;
      padding: 2rem 1.5rem 4rem;
    }
    .container { max-width: 1100px; margin: 0 auto; }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 2rem;
      padding-bottom: 1.5rem;
      border-bottom: 1px solid var(--border);
    }
    .brand { display: flex; align-items: center; gap: 0.75rem; }
    .brand-logo {
      width: 42px; height: 42px;
      background: linear-gradient(135deg, var(--accent), #ff5e36);
      border-radius: 12px;
      display: flex; align-items: center; justify-content: center;
      font-weight: 800; font-size: 1.3rem; color: #fff;
      box-shadow: 0 0 20px var(--accent-glow);
    }
    .brand h1 { font-size: 1.5rem; font-weight: 800; letter-spacing: -0.03em; }
    .header-badges { display: flex; gap: 0.6rem; align-items: center; }
    .tier-badge {
      font-size: 0.75rem;
      padding: 0.35rem 0.75rem;
      border-radius: 999px;
      background: rgba(16, 185, 129, 0.15);
      border: 1px solid rgba(16, 185, 129, 0.3);
      color: #34d399;
      font-weight: 600;
      letter-spacing: 0.05em;
    }
    .jev-badge-top {
      font-size: 0.75rem;
      padding: 0.35rem 0.75rem;
      border-radius: 999px;
      background: rgba(168, 85, 247, 0.15);
      border: 1px solid rgba(168, 85, 247, 0.3);
      color: #c084fc;
      font-weight: 600;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 1.5rem;
      backdrop-filter: blur(16px);
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.35);
      margin-bottom: 2rem;
    }
    .card-title {
      font-size: 1.15rem;
      font-weight: 700;
      margin-bottom: 0.4rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .card-desc {
      font-size: 0.85rem;
      color: var(--text-muted);
      margin-bottom: 1.25rem;
      line-height: 1.4;
    }
    .input-group {
      display: flex;
      gap: 0.5rem;
    }
    input[type="url"], input[type="text"] {
      flex: 1;
      padding: 0.8rem 1rem;
      background: rgba(11, 15, 25, 0.8);
      border: 1px solid var(--border);
      border-radius: 10px;
      color: var(--text);
      font-size: 0.95rem;
      outline: none;
      transition: all 0.2s;
    }
    input[type="url"]:focus, input[type="text"]:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-glow);
    }
    .btn {
      padding: 0.8rem 1.4rem;
      background: linear-gradient(135deg, var(--accent), #ff5e36);
      color: #fff;
      border: none;
      border-radius: 10px;
      font-weight: 600;
      font-size: 0.9rem;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 0.5rem;
      transition: all 0.2s;
    }
    .btn:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 16px var(--accent-glow);
    }
    .btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
      transform: none;
    }
    .bookmarklet-box {
      margin-top: 1rem;
      padding: 0.8rem 1rem;
      background: rgba(255, 255, 255, 0.03);
      border-radius: 10px;
      border: 1px dashed var(--border);
      font-size: 0.82rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 0.75rem;
    }
    .bookmarklet-link {
      display: inline-block;
      padding: 0.4rem 0.85rem;
      background: rgba(246, 130, 31, 0.15);
      border: 1px solid var(--accent);
      color: var(--accent);
      border-radius: 8px;
      font-weight: 600;
      text-decoration: none;
      cursor: grab;
      font-size: 0.8rem;
    }
    .progress-panel {
      margin-top: 1rem;
      display: none;
    }
    .progress-bar-bg {
      height: 8px;
      background: rgba(255, 255, 255, 0.06);
      border-radius: 4px;
      overflow: hidden;
      margin-bottom: 0.5rem;
    }
    .progress-bar-fill {
      height: 100%;
      width: 0%;
      background: linear-gradient(90deg, var(--accent), var(--cyan));
      border-radius: 4px;
      transition: width 0.4s ease;
    }
    .progress-status {
      display: flex;
      justify-content: space-between;
      font-size: 0.75rem;
      color: var(--text-muted);
    }

    /* ========================================================
       CLEAN AI CHAT UI & FORMATTED RENDERER STYLES
       ======================================================== */
    .chat-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 18px;
      overflow: hidden;
      margin-bottom: 2.5rem;
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
      backdrop-filter: blur(20px);
    }
    .chat-header {
      padding: 1.25rem 1.5rem;
      background: rgba(14, 20, 35, 0.95);
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .chat-header-info {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    .chat-ai-avatar {
      width: 36px; height: 36px;
      border-radius: 10px;
      background: linear-gradient(135deg, #00d2ff, #3b82f6);
      display: flex; align-items: center; justify-content: center;
      font-size: 1.1rem;
      box-shadow: 0 0 16px var(--cyan-glow);
    }
    .chat-header-title {
      font-weight: 700;
      font-size: 1rem;
      color: #fff;
    }
    .chat-header-status {
      font-size: 0.75rem;
      color: var(--cyan);
      display: flex;
      align-items: center;
      gap: 0.35rem;
    }
    .status-dot {
      width: 7px; height: 7px;
      border-radius: 50%;
      background: #10b981;
      display: inline-block;
      box-shadow: 0 0 8px #10b981;
    }
    .btn-clear-chat {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-muted);
      padding: 0.35rem 0.75rem;
      border-radius: 8px;
      font-size: 0.75rem;
      cursor: pointer;
      transition: all 0.2s;
    }
    .btn-clear-chat:hover {
      background: rgba(255, 255, 255, 0.06);
      color: #fff;
    }
    .chat-messages {
      padding: 1.5rem;
      min-height: 260px;
      max-height: 480px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 1.25rem;
      scroll-behavior: smooth;
    }
    .chat-bubble {
      display: flex;
      gap: 0.85rem;
      max-width: 88%;
      animation: fadeIn 0.3s ease-out;
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .chat-bubble.user {
      align-self: flex-end;
      flex-direction: row-reverse;
    }
    .chat-bubble.assistant {
      align-self: flex-start;
    }
    .avatar-bubble {
      width: 32px; height: 32px;
      border-radius: 8px;
      flex-shrink: 0;
      display: flex; align-items: center; justify-content: center;
      font-size: 0.85rem;
      font-weight: 700;
    }
    .avatar-user {
      background: linear-gradient(135deg, var(--accent), #ff5e36);
      color: #fff;
    }
    .avatar-ai {
      background: linear-gradient(135deg, #00d2ff, #3b82f6);
      color: #fff;
    }
    .bubble-content {
      padding: 0.95rem 1.25rem;
      border-radius: 14px;
      font-size: 0.92rem;
      line-height: 1.6;
    }
    .user .bubble-content {
      background: linear-gradient(135deg, rgba(246, 130, 31, 0.2), rgba(246, 130, 31, 0.1));
      border: 1px solid var(--border-accent);
      color: #fff;
      border-top-right-radius: 2px;
    }
    .assistant .bubble-content {
      background: var(--card-bg-light);
      border: 1px solid var(--border);
      color: #e2e8f0;
      border-top-left-radius: 2px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.2);
    }
    
    /* Markdown Output Formatting Styles */
    .markdown-body {
      word-break: break-word;
    }
    .markdown-body p { margin-bottom: 0.75rem; }
    .markdown-body p:last-child { margin-bottom: 0; }
    .markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body h4 {
      color: #fff;
      margin-top: 1rem;
      margin-bottom: 0.5rem;
      font-weight: 700;
    }
    .markdown-body h1 { font-size: 1.25rem; }
    .markdown-body h2 { font-size: 1.1rem; }
    .markdown-body h3 { font-size: 1rem; }
    .markdown-body ul, .markdown-body ol {
      margin-left: 1.25rem;
      margin-bottom: 0.75rem;
    }
    .markdown-body li {
      margin-bottom: 0.35rem;
    }
    .markdown-body code {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.85em;
      background: rgba(0, 0, 0, 0.4);
      padding: 0.15rem 0.4rem;
      border-radius: 4px;
      color: #38bdf8;
      border: 1px solid rgba(255, 255, 255, 0.08);
    }
    .markdown-body pre {
      background: #060913;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 0.85rem;
      margin: 0.75rem 0;
      overflow-x: auto;
    }
    .markdown-body pre code {
      background: transparent;
      padding: 0;
      border: none;
      color: #f1f5f9;
      font-size: 0.85rem;
    }
    .markdown-body blockquote {
      border-left: 3px solid var(--accent);
      padding-left: 0.85rem;
      margin: 0.75rem 0;
      color: var(--text-muted);
      font-style: italic;
    }
    .markdown-body a {
      color: var(--cyan);
      text-decoration: none;
    }
    .markdown-body a:hover {
      text-decoration: underline;
    }

    /* JEV RAG Verification Pill */
    .jev-grounded-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.45rem;
      padding: 0.35rem 0.75rem;
      border-radius: 999px;
      font-size: 0.75rem;
      font-weight: 700;
      margin-top: 0.75rem;
      letter-spacing: 0.02em;
    }
    .jev-grounded-badge.verified {
      background: rgba(16, 185, 129, 0.15);
      border: 1px solid rgba(16, 185, 129, 0.4);
      color: #34d399;
    }
    .jev-grounded-badge.warning {
      background: rgba(245, 158, 11, 0.15);
      border: 1px solid rgba(245, 158, 11, 0.4);
      color: #fbbf24;
    }
    .jev-grounded-badge.autocorrected {
      background: rgba(168, 85, 247, 0.15);
      border: 1px solid rgba(168, 85, 247, 0.4);
      color: #c084fc;
    }
    .jev-dot {
      width: 7px; height: 7px;
      border-radius: 50%;
    }
    .jev-dot.verified {
      background: #10b981;
      box-shadow: 0 0 8px var(--green-glow);
    }
    .jev-dot.warning {
      background: #f59e0b;
      box-shadow: 0 0 8px var(--yellow-glow);
    }
    .jev-dot.autocorrected {
      background: #a855f7;
      box-shadow: 0 0 8px rgba(168, 85, 247, 0.4);
    }

    /* Citations in Chat */
    .chat-citations {
      margin-top: 0.85rem;
      padding-top: 0.75rem;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
    }
    .citations-header {
      font-size: 0.75rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--cyan);
      margin-bottom: 0.5rem;
      display: flex;
      align-items: center;
      gap: 0.35rem;
    }
    .citation-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
    }
    .citation-chip {
      background: rgba(0, 210, 255, 0.06);
      border: 1px solid rgba(0, 210, 255, 0.2);
      border-radius: 8px;
      padding: 0.4rem 0.65rem;
      font-size: 0.75rem;
      display: flex;
      align-items: center;
      gap: 0.4rem;
      color: #e2e8f0;
      text-decoration: none;
      transition: all 0.2s;
    }
    .citation-chip:hover {
      background: rgba(0, 210, 255, 0.12);
      border-color: var(--cyan);
      transform: translateY(-1px);
    }
    .citation-score {
      background: rgba(0, 210, 255, 0.2);
      color: var(--cyan);
      font-weight: 700;
      padding: 0.1rem 0.35rem;
      border-radius: 4px;
      font-size: 0.7rem;
    }

    /* Chat Suggestion Chips */
    .chat-suggestions {
      padding: 0 1.5rem 0.75rem;
      display: flex;
      gap: 0.5rem;
      overflow-x: auto;
    }
    .suggestion-chip {
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 0.35rem 0.85rem;
      font-size: 0.78rem;
      color: var(--text-muted);
      cursor: pointer;
      white-space: nowrap;
      transition: all 0.2s;
    }
    .suggestion-chip:hover {
      background: rgba(255, 255, 255, 0.08);
      color: #fff;
      border-color: rgba(255, 255, 255, 0.2);
    }

    /* Chat Input Form */
    .chat-footer {
      padding: 1rem 1.5rem 1.25rem;
      background: rgba(14, 20, 35, 0.8);
      border-top: 1px solid var(--border);
    }
    .chat-form {
      display: flex;
      gap: 0.6rem;
    }
    .chat-input {
      flex: 1;
      padding: 0.85rem 1.1rem;
      background: rgba(11, 15, 25, 0.95);
      border: 1px solid var(--border);
      border-radius: 12px;
      color: var(--text);
      font-size: 0.95rem;
      outline: none;
      transition: all 0.2s;
    }
    .chat-input:focus {
      border-color: var(--cyan);
      box-shadow: 0 0 0 3px var(--cyan-glow);
    }
    .chat-submit-btn {
      padding: 0.85rem 1.4rem;
      background: linear-gradient(135deg, #00d2ff, #3b82f6);
      color: #fff;
      border: none;
      border-radius: 12px;
      font-weight: 700;
      font-size: 0.95rem;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 0.4rem;
      transition: all 0.2s;
      box-shadow: 0 4px 14px var(--cyan-glow);
    }
    .chat-submit-btn:hover {
      transform: translateY(-1px);
      box-shadow: 0 6px 20px var(--cyan-glow);
    }
    .chat-submit-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      transform: none;
    }

    /* Typing Pulse Indicator */
    .typing-indicator {
      display: flex;
      align-items: center;
      gap: 0.35rem;
      padding: 0.5rem 0.25rem;
    }
    .typing-dot {
      width: 6px; height: 6px;
      border-radius: 50%;
      background: var(--cyan);
      animation: typingPulse 1.2s infinite ease-in-out;
    }
    .typing-dot:nth-child(2) { animation-delay: 0.2s; }
    .typing-dot:nth-child(3) { animation-delay: 0.4s; }
    @keyframes typingPulse {
      0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
      40% { transform: scale(1.1); opacity: 1; }
    }

    /* Vault Grid & Document Cards */
    .vault-section { margin-top: 1rem; }
    .section-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1.25rem;
    }
    .section-header h2 { font-size: 1.25rem; font-weight: 700; }
    .doc-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(330px, 1fr));
      gap: 1.25rem;
    }
    .doc-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 14px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      transition: transform 0.2s, border-color 0.2s;
    }
    .doc-card:hover {
      transform: translateY(-2px);
      border-color: rgba(255, 255, 255, 0.2);
    }
    .doc-thumb {
      height: 140px;
      background: #1e293b;
      position: relative;
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .doc-thumb img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .source-badge {
      position: absolute;
      top: 0.5rem;
      right: 0.5rem;
      font-size: 0.65rem;
      font-weight: 700;
      text-transform: uppercase;
      padding: 0.2rem 0.5rem;
      border-radius: 4px;
      background: rgba(0, 0, 0, 0.75);
      color: #fff;
      backdrop-filter: blur(4px);
    }
    .jev-card-header {
      display: flex;
      gap: 0.4rem;
      align-items: center;
      flex-wrap: wrap;
      margin-bottom: 0.5rem;
    }
    .badge-jev {
      font-size: 0.65rem;
      font-weight: 700;
      padding: 0.15rem 0.45rem;
      border-radius: 6px;
      background: rgba(168, 85, 247, 0.2);
      border: 1px solid rgba(168, 85, 247, 0.4);
      color: #c084fc;
      text-transform: uppercase;
    }
    .badge-density {
      font-size: 0.65rem;
      font-weight: 700;
      padding: 0.15rem 0.45rem;
      border-radius: 6px;
      background: rgba(16, 185, 129, 0.15);
      border: 1px solid rgba(16, 185, 129, 0.3);
      color: #34d399;
    }
    .badge-category {
      font-size: 0.65rem;
      font-weight: 700;
      padding: 0.15rem 0.45rem;
      border-radius: 6px;
      background: rgba(0, 210, 255, 0.15);
      border: 1px solid rgba(0, 210, 255, 0.3);
      color: #38bdf8;
      text-transform: uppercase;
    }
    .doc-content {
      padding: 1.1rem;
      flex: 1;
      display: flex;
      flex-direction: column;
    }
    .doc-title {
      font-size: 0.95rem;
      font-weight: 700;
      line-height: 1.35;
      margin-bottom: 0.4rem;
      color: #fff;
      text-decoration: none;
    }
    .doc-meta {
      font-size: 0.75rem;
      color: var(--text-muted);
      margin-bottom: 0.65rem;
      display: flex;
      gap: 0.5rem;
      align-items: center;
    }
    .doc-summary {
      font-size: 0.8rem;
      color: #cbd5e1;
      line-height: 1.45;
      margin-bottom: 0.75rem;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    /* JEV 3-Bullet TL;DR Expandable Accordion */
    .tldr-accordion {
      margin-bottom: 0.75rem;
      background: rgba(0, 0, 0, 0.25);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 8px;
      padding: 0.45rem 0.65rem;
      font-size: 0.75rem;
    }
    .tldr-accordion summary {
      cursor: pointer;
      font-weight: 700;
      color: var(--cyan);
      user-select: none;
      outline: none;
    }
    .tldr-accordion ul {
      margin-top: 0.4rem;
      margin-left: 1.1rem;
      line-height: 1.45;
      color: #e2e8f0;
    }
    .tldr-accordion li {
      margin-bottom: 0.25rem;
    }

    /* Tags List */
    .tags-container {
      display: flex;
      flex-wrap: wrap;
      gap: 0.3rem;
      margin-bottom: 0.75rem;
    }
    .tag-chip {
      font-size: 0.68rem;
      padding: 0.15rem 0.45rem;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.08);
      color: var(--text-muted);
    }

    .doc-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-top: 0.75rem;
      border-top: 1px solid var(--border);
      font-size: 0.75rem;
      margin-top: auto;
    }
    .status-pill {
      font-size: 0.65rem;
      padding: 0.15rem 0.5rem;
      border-radius: 999px;
      font-weight: 600;
      text-transform: uppercase;
    }
    .status-indexed { background: rgba(16, 185, 129, 0.2); color: #34d399; }
    .status-processing { background: rgba(245, 158, 11, 0.2); color: #fbbf24; }
    .status-pending { background: rgba(148, 163, 184, 0.2); color: #94a3b8; }
    .status-rejected_by_jev { background: rgba(239, 68, 68, 0.2); color: #f87171; }
    .action-link {
      color: var(--accent);
      text-decoration: none;
      font-weight: 600;
    }
    .action-link:hover { text-decoration: underline; }
    .btn-delete {
      background: transparent;
      border: 1px solid rgba(239, 68, 68, 0.3);
      color: #f87171;
      padding: 0.25rem 0.5rem;
      border-radius: 6px;
      font-size: 0.75rem;
      cursor: pointer;
      transition: all 0.2s;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .btn-delete:hover {
      background: rgba(239, 68, 68, 0.2);
      border-color: #ef4444;
      transform: scale(1.08);
    }
    .empty-state {
      grid-column: 1 / -1;
      text-align: center;
      padding: 3rem 1rem;
      background: var(--card-bg);
      border: 1px dashed var(--border);
      border-radius: 12px;
      color: var(--text-muted);
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="brand">
        <div class="brand-logo">C</div>
        <div>
          <h1>ClipMind</h1>
          <p style="font-size: 0.8rem; color: var(--text-muted);">Cloudflare-Native Edge Web Clipper & Knowledge Vault</p>
        </div>
      </div>
      <div class="header-badges">
        <span class="jev-badge-top">🛡️ JEV-1.14.0 Guardrails</span>
        <span class="tier-badge">100% Free Tier ($0/mo)</span>
      </div>
    </header>

    <!-- Quick Ingestion Section -->
    <div class="card">
      <h2 class="card-title">
        <span>⚡</span> Quick Web Article Clipper
      </h2>
      <p class="card-desc">Headless Chrome extraction, R2 archiving, TypeSafe JEV-1.14.0 structured evaluation, and Vectorize indexing.</p>
      
      <form id="clipForm" onsubmit="handleClip(event)">
        <div class="input-group">
          <input type="url" id="clipUrl" placeholder="https://example.com/article" required />
          <button type="submit" class="btn" id="clipSubmitBtn">Clip Page</button>
        </div>
      </form>

      <div id="progressPanel" class="progress-panel">
        <div class="progress-bar-bg">
          <div id="progressBar" class="progress-bar-fill"></div>
        </div>
        <div class="progress-status">
          <span id="progressStage">Initializing workflow...</span>
          <span id="progressPercent">0%</span>
        </div>
      </div>

      <div class="bookmarklet-box">
        <span>📌 <strong>Browser Bookmarklet:</strong> Drag this link to your browser bookmarks bar:</span>
        <a class="bookmarklet-link" href="${bookmarkletCode}" onclick="alert('Drag this button to your browser bookmarks bar to clip any article with 1 click!'); return false;">Clip to ClipMind</a>
      </div>
    </div>

    <!-- CLEAN INTERACTIVE AI CHAT UI WITH ACTUAL MARKDOWN RENDERER & JEV GUARDRAIL -->
    <div class="chat-card">
      <div class="chat-header">
        <div class="chat-header-info">
          <div class="chat-ai-avatar">🔮</div>
          <div>
            <div class="chat-header-title">ClipMind Knowledge Assistant</div>
            <div class="chat-header-status">
              <span class="status-dot"></span>
              <span>Llama 3.2 3B Instruct @ Edge • JEV-1.14.0 Grounded RAG</span>
            </div>
          </div>
        </div>
        <button type="button" class="btn-clear-chat" onclick="clearChat()">Clear History</button>
      </div>

      <!-- Scrollable Message Thread -->
      <div id="chatMessages" class="chat-messages">
        <!-- Initial Greeting Message -->
        <div class="chat-bubble assistant">
          <div class="avatar-bubble avatar-ai">AI</div>
          <div class="bubble-content">
            <div class="markdown-body">
              <p>👋 <strong>Welcome to your Knowledge Vault Assistant!</strong></p>
              <p>I can answer questions, summarize topics, and synthesize insights directly from your clipped articles and saved documents. Every answer is evaluated against <strong>TypeSafe JEV-1.14.0</strong> to ensure strict factual groundedness and prevent hallucinations.</p>
            </div>
          </div>
        </div>
      </div>

      <!-- Quick Suggestion Chips -->
      <div class="chat-suggestions">
        <button class="suggestion-chip" onclick="applySuggestion('What are the key topics in my saved documents?')">🔍 Key topics in my vault</button>
        <button class="suggestion-chip" onclick="applySuggestion('Summarize the most recent article I clipped.')">📝 Summarize latest article</button>
        <button class="suggestion-chip" onclick="applySuggestion('Give me an overview of Cloudflare Workers and Workflows.')">⚡ Cloudflare Workers overview</button>
      </div>

      <!-- Chat Input Dock -->
      <div class="chat-footer">
        <form id="chatForm" class="chat-form" onsubmit="handleChatSubmit(event)">
          <input 
            type="text" 
            id="chatInput" 
            class="chat-input" 
            placeholder="Ask anything about your saved articles..." 
            autocomplete="off" 
            required 
          />
          <button type="submit" class="chat-submit-btn" id="chatSubmitBtn">
            <span>Ask</span>
            <span>➤</span>
          </button>
        </form>
      </div>
    </div>

    <!-- Vault Documents Grid -->
    <div class="vault-section">
      <div class="section-header">
        <h2>Indexed Knowledge Vault (${documents.length})</h2>
      </div>

      <div class="doc-grid">
        ${
          documents.length === 0
            ? `<div class="empty-state">
                <p>No documents clipped yet.</p>
                <p style="font-size: 0.8rem; margin-top: 0.5rem;">Enter a URL above or share a link in Discord with <code>/clip</code> to get started.</p>
               </div>`
            : documents
                .map((doc) => {
                  const estTime = Math.max(1, Math.ceil((doc.word_count || 0) / 200));
                  const dateStr = new Date(doc.created_at).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                  });

                  let tldrBullets: string[] = [];
                  if (doc.tldr_json) {
                    try {
                      tldrBullets = JSON.parse(doc.tldr_json);
                    } catch {}
                  }

                  const tags = (doc.tags_list || "").split(",").filter(Boolean);

                  return `
            <div class="doc-card" id="doc-${doc.id}">
              <div class="doc-thumb">
                <img src="/api/raw/screenshot/${doc.id}" onerror="this.style.display='none'" alt="Snapshot preview" />
                <span class="source-badge">${doc.source}</span>
              </div>
              <div class="doc-content">
                <div class="jev-card-header">
                  ${doc.jev_verified ? '<span class="badge-jev">🛡️ JEV Verified</span>' : ""}
                  ${doc.quality_score ? `<span class="badge-density">⚡ Density: ${(doc.quality_score * 100).toFixed(0)}%</span>` : ""}
                  ${doc.category && doc.category !== "uncategorized" ? `<span class="badge-category">${doc.category}</span>` : ""}
                </div>

                <a href="${doc.url}" target="_blank" rel="noopener" class="doc-title">
                  ${doc.title || doc.url}
                </a>

                <div class="doc-meta">
                  <span>${dateStr}</span>
                  <span>•</span>
                  <span>~${estTime} min read (${doc.word_count || 0} words)</span>
                  ${doc.author ? `<span>•</span><span>By ${doc.author}</span>` : ""}
                </div>

                ${
                  tldrBullets.length > 0
                    ? `
                  <details class="tldr-accordion">
                    <summary>💡 JEV 3-Bullet TL;DR</summary>
                    <ul>
                      ${tldrBullets.map((b) => `<li>${b}</li>`).join("")}
                    </ul>
                  </details>
                `
                    : ""
                }

                <div class="doc-summary">
                  ${doc.rejection_reason ? `<span style="color:var(--red);">Rejection Reason: ${doc.rejection_reason}</span>` : (doc.summary || "No description provided.")}
                </div>

                ${
                  tags.length > 0
                    ? `
                  <div class="tags-container">
                    ${tags.map((t) => `<span class="tag-chip">#${t}</span>`).join("")}
                  </div>
                `
                    : ""
                }

                <div class="doc-footer">
                  <span class="status-pill status-${doc.status}">${doc.status}</span>
                  <div style="display: flex; gap: 0.65rem; align-items: center;">
                    <a href="/api/raw/snapshot/${doc.id}" target="_blank" class="action-link">Markdown ↗</a>
                    <button type="button" class="btn-delete" onclick="deleteDocument('${doc.id}', event)" title="Permanently delete from vault">🗑️</button>
                  </div>
                </div>
              </div>
            </div>`;
                })
                .join("")
        }
      </div>
    </div>
  </div>

  <script>
    // Configure marked options
    if (window.marked) {
      marked.setOptions({
        gfm: true,
        breaks: true,
      });
    }

    // Durable Object WebSocket Setup
    let ws;
    function initWebSocket() {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(protocol + '//' + location.host + '/ws');

      ws.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (payload.type === 'progress' || payload.type === 'complete' || payload.type === 'error') {
            const panel = document.getElementById('progressPanel');
            const bar = document.getElementById('progressBar');
            const stage = document.getElementById('progressStage');
            const pct = document.getElementById('progressPercent');

            panel.style.display = 'block';
            bar.style.width = (payload.percent || 0) + '%';
            stage.textContent = payload.message || payload.stage || 'Processing...';
            pct.textContent = (payload.percent || 0) + '%';

            if (payload.type === 'complete') {
              setTimeout(() => {
                location.reload();
              }, 1200);
            }
          }
        } catch (e) {
          console.error('WS message error:', e);
        }
      };

      ws.onclose = () => {
        setTimeout(initWebSocket, 3000);
      };
    }
    initWebSocket();

    // Clip Form Handler
    async function handleClip(e) {
      e.preventDefault();
      const urlInput = document.getElementById('clipUrl');
      const submitBtn = document.getElementById('clipSubmitBtn');
      const url = urlInput.value.trim();
      if (!url) return;

      submitBtn.disabled = true;
      submitBtn.textContent = 'Dispatching...';

      const panel = document.getElementById('progressPanel');
      panel.style.display = 'block';
      document.getElementById('progressStage').textContent = 'Submitting to Cloudflare Workflow...';
      document.getElementById('progressBar').style.width = '10%';
      document.getElementById('progressPercent').textContent = '10%';

      try {
        const resp = await fetch('/api/clip', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, source: 'web' })
        });
        const data = await resp.json();
        if (data.error) {
          alert('Error: ' + data.error);
          panel.style.display = 'none';
        } else {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'subscribe', docId: data.docId }));
          }
        }
      } catch (err) {
        alert('Failed to dispatch clip workflow: ' + err.message);
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Clip Page';
      }
    }

    // Suggestions Helper
    function applySuggestion(text) {
      const input = document.getElementById('chatInput');
      input.value = text;
      handleChatSubmit(new Event('submit'));
    }

    // Clear Chat History
    function clearChat() {
      const messagesContainer = document.getElementById('chatMessages');
      messagesContainer.innerHTML = \`
        <div class="chat-bubble assistant">
          <div class="avatar-bubble avatar-ai">AI</div>
          <div class="bubble-content">
            <div class="markdown-body">
              <p>Chat cleared. What would you like to explore next in your vault?</p>
            </div>
          </div>
        </div>\`;
    }

    // Scroll chat to bottom
    function scrollChatToBottom() {
      const messagesContainer = document.getElementById('chatMessages');
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    // Clean AI Chat Submit Handler with Actual Markdown Renderer & JEV Grounding Guardrail
    async function handleChatSubmit(e) {
      if (e) e.preventDefault();
      const input = document.getElementById('chatInput');
      const submitBtn = document.getElementById('chatSubmitBtn');
      const messagesContainer = document.getElementById('chatMessages');

      const query = input.value.trim();
      if (!query) return;

      // 1. Append User Message Bubble
      const userBubble = document.createElement('div');
      userBubble.className = 'chat-bubble user';
      userBubble.innerHTML = \`
        <div class="avatar-bubble avatar-user">You</div>
        <div class="bubble-content">\${escapeHtml(query)}</div>
      \`;
      messagesContainer.appendChild(userBubble);
      input.value = '';
      scrollChatToBottom();

      // 2. Append Loading Placeholder
      submitBtn.disabled = true;
      const loadingBubble = document.createElement('div');
      loadingBubble.className = 'chat-bubble assistant';
      loadingBubble.id = 'activeAiLoading';
      loadingBubble.innerHTML = \`
        <div class="avatar-bubble avatar-ai">AI</div>
        <div class="bubble-content">
          <div class="typing-indicator">
            <span class="typing-dot"></span>
            <span class="typing-dot"></span>
            <span class="typing-dot"></span>
            <span style="font-size: 0.8rem; color: var(--cyan); margin-left: 0.5rem;">Synthesizing with Llama 3.2 & running TypeSafe JEV-1.14.0 guardrail...</span>
          </div>
        </div>
      \`;
      messagesContainer.appendChild(loadingBubble);
      scrollChatToBottom();

      try {
        const resp = await fetch('/api/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, topK: 5 })
        });
        const data = await resp.json();

        // Remove loading bubble
        loadingBubble.remove();

        // 3. Render Formatted Assistant Response
        const assistantBubble = document.createElement('div');
        assistantBubble.className = 'chat-bubble assistant';

        let formattedMarkdown = '';
        if (data.error) {
          formattedMarkdown = \`<p style="color:var(--red);">⚠️ <strong>Error:</strong> \${escapeHtml(data.error)}</p>\`;
        } else {
          // Render markdown through marked
          formattedMarkdown = window.marked 
            ? marked.parse(data.answer || 'No answer provided.') 
            : escapeHtml(data.answer);
        }

        // Build JEV Groundedness Badge
        let jevBadgeHtml = '';
        if (data.jevEvaluation) {
          const isGrounded = data.jevEvaluation.isGrounded;
          const score = Math.round((data.jevEvaluation.confidenceScore || 0) * 100);
          const warning = data.jevEvaluation.hallucinationWarning;

          if (data.autoCorrected) {
            jevBadgeHtml = \`
              <div class="jev-grounded-badge autocorrected">
                <span class="jev-dot autocorrected"></span>
                <span>🛡️ TypeSafe JEV Self-Correction Applied • Extrapolated claims removed</span>
              </div>
            \`;
          } else if (isGrounded) {
            jevBadgeHtml = \`
              <div class="jev-grounded-badge verified">
                <span class="jev-dot verified"></span>
                <span>TypeSafe JEV Verified • \${score}% Grounded</span>
              </div>
            \`;
          } else {
            jevBadgeHtml = \`
              <div class="jev-grounded-badge warning">
                <span class="jev-dot warning"></span>
                <span>JEV Warning: Low Groundedness (\${escapeHtml(warning || 'Extrapolated beyond context')})</span>
              </div>
            \`;
          }
        }

        // Build citations list if available
        let citationsHtml = '';
        if (data.citations && data.citations.length > 0) {
          citationsHtml = \`
            <div class="chat-citations">
              <div class="citations-header">📚 Referenced Vault Sources</div>
              <div class="citation-chips">
                \${data.citations.map((c, i) => \`
                  <a href="\${c.url}" target="_blank" rel="noopener" class="citation-chip" title="\${escapeHtml(c.snippet)}">
                    <span class="citation-score">#\${i + 1}</span>
                    <span>\${escapeHtml(c.title || 'Untitled')}</span>
                    \${c.score ? \`<span style="opacity:0.75; font-size:0.68rem;">(\${(c.score * 100).toFixed(0)}%)</span>\` : ''}
                    <span>↗</span>
                  </a>
                \`).join('')}
              </div>
            </div>
          \`;
        }

        assistantBubble.innerHTML = \`
          <div class="avatar-bubble avatar-ai">AI</div>
          <div class="bubble-content">
            <div class="markdown-body">\${formattedMarkdown}</div>
            \${jevBadgeHtml}
            \${citationsHtml}
          </div>
        \`;

        messagesContainer.appendChild(assistantBubble);
        scrollChatToBottom();
      } catch (err) {
        if (loadingBubble) loadingBubble.remove();
        const errorBubble = document.createElement('div');
        errorBubble.className = 'chat-bubble assistant';
        errorBubble.innerHTML = \`
          <div class="avatar-bubble avatar-ai">AI</div>
          <div class="bubble-content">
            <div class="markdown-body" style="color:var(--red);">
              <p>Failed to retrieve synthesis: \${escapeHtml(err.message)}</p>
            </div>
          </div>
        \`;
        messagesContainer.appendChild(errorBubble);
        scrollChatToBottom();
      } finally {
        submitBtn.disabled = false;
        input.focus();
      }
    }

    async function deleteDocument(docId, event) {
      if (event) event.stopPropagation();
      if (!confirm("Are you sure you want to permanently delete this document, its vector chunks, and R2 snapshot?")) {
        return;
      }

      const card = document.getElementById('doc-' + docId);
      if (card) {
        card.style.opacity = '0.4';
        card.style.pointerEvents = 'none';
      }

      try {
        const resp = await fetch('/api/clip/' + docId, {
          method: 'DELETE',
        });
        const data = await resp.json();
        if (data.error) {
          alert('Delete failed: ' + data.error);
          if (card) {
            card.style.opacity = '1';
            card.style.pointerEvents = 'auto';
          }
        } else {
          if (card) {
            card.style.transition = 'all 0.3s ease';
            card.style.transform = 'scale(0.85) translateY(12px)';
            card.style.opacity = '0';
            setTimeout(() => {
              card.remove();
              const remaining = document.querySelectorAll('.doc-card').length;
              const header = document.querySelector('.section-header h2');
              if (header) header.textContent = 'Indexed Knowledge Vault (' + remaining + ')';
            }, 300);
          }
        }
      } catch (err) {
        alert('Error deleting document: ' + err.message);
        if (card) {
          card.style.opacity = '1';
          card.style.pointerEvents = 'auto';
        }
      }
    }

    function escapeHtml(str) {
      if (!str) return '';
      return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }
  </script>
</body>
</html>`);
});
