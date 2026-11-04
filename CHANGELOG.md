# Changelog

All notable changes to Levi are documented here.

---

## [Unreleased]

### Added
- `/undo` — turn rollback and file snapshot recovery before destructive edits
- `/diff` — interactive fullscreen scrollable git diff reviewer with syntax coloring
- `/commit` — conventional commit message generator and optional remote push
- `/bg` — background process manager with status inspection and live log tailing
- `/find` & `Ctrl+P` — fuzzy file palette to search and inject project file paths
- Project Playbook (`LEVI.md` / `.levirules`) auto-read from working directory into context
- Self-Healing Verification Loop — automatic syntax check (`node --check`, `py_compile`, JSON) on edits
- Parallel Tool Execution — concurrent batch execution of read-only tools via `Promise.all`
- Hybrid Semantic Vector Search — Reciprocal Rank Fusion of BM25 FTS5 and MiniLM embeddings
- `/changelog` — fullscreen scrollable viewer rethemed to Levi cyber-minimalist cyan palette
- `/effort` — streamlined menu styling with clean white highlight for active reasoning level
- `/title <name>` — rename the current session
- `/delete` — hard-delete the current session with confirmation
- `/index:rebuild` — rebuild the FTS5 semantic search index
- `retrieve` tool — search past sessions and memory notes via FTS5 index
- Onboarding setup flow in `welcome.js` (model + Serper API key)

---

## [0.1.0] — Initial Release

### Added
- Multi-model support: Gemini, OpenAI, Anthropic, Groq, OpenRouter, Ollama, Custom
- Session management: create, resume, compact, end sessions
- Memory system: `remember`, `forget`, `memory:push`, `memory:sync`
- Project tracking per session
- MCP (Model Context Protocol) server support
- `/model` — switch or configure AI models
- `/resume` — resume a past session
- `/compact` — summarize and compress the current session
- `/end` — end and compact the current session
- `/mcp:add`, `/mcp:remove` — manage MCP servers
- Router: auto-selects agent vs. lite mode per message
- FTS5 search index over sessions, memory, and projects
- Web search via Serper API
- Task tracking with `add_task` / `update_task`
- Rich terminal UI built with Ink + React
