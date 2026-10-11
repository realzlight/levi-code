# Changelog

All notable changes to Levi are documented here.

---

## [Unreleased]

### Added
- `/changelog` — view this changelog in a fullscreen overlay
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
