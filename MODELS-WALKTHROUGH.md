# Levi Model Management — Walkthrough & Reference

Welcome to the **Levi Multi-Model Management Guide**. Levi gives you complete freedom to use any AI provider or local offline model with zero platform lock-in. Bring your own API keys, configure custom endpoints, and switch models on the fly.

---

## 1. Core Architecture & Supported Protocols

Levi standardizes model communication across two industry-standard protocols:

| Protocol | Compatible Providers & Endpoints | Features Supported |
| :--- | :--- | :--- |
| **OpenAI Compatible** | OpenAI, Google Gemini, Groq, NVIDIA NIM, Ollama, DeepSeek, OpenRouter, Together AI, LM Studio, vLLM | Streaming, tool calling, JSON schema, variable temperature |
| **Anthropic** | Anthropic Claude API (Sonnet 3.5, Opus 3, Haiku 3.5) | Extended thinking, prompt caching, tool use |

### Configuration Storage: `~/.levi/config.json`
Models are stored locally under the `models` dictionary, with `activeModel` defining the session default:
```json
{
  "activeModel": "gpt-4o",
  "models": {
    "gpt-4o": {
      "sdk": "openai",
      "model": "gpt-4o",
      "api_key": "sk-proj-...",
      "base_url": "https://api.openai.com/v1"
    },
    "claude": {
      "sdk": "anthropic",
      "model": "claude-3-5-sonnet-20241022",
      "api_key": "sk-ant-...",
      "base_url": "https://api.anthropic.com"
    },
    "local-llama": {
      "sdk": "openai",
      "model": "llama3.3:70b",
      "api_key": "ollama",
      "base_url": "http://localhost:11434/v1"
    }
  }
}
```

---

## 2. Command Reference

### Inside Interactive Session (Slash Commands)
| Command | Syntax | Description |
| :--- | :--- | :--- |
| `/models` | `/models` | Opens this fullscreen interactive walkthrough guide. |
| `/models:list` | `/models:list` | Displays all configured models with SDK and active indicator. |
| `/models:use` | `/models:use <name>` | Instantly switches the active model for the current session. |
| `/models:create` | `/models:create` | Opens interactive wizard to add a new model configuration. |
| `/models:edit` | `/models:edit <name>` | Opens modal editor to update API key, base URL, or model ID. |
| `/models:delete` | `/models:delete <name>` | Removes a model configuration from `config.json`. |

### From the Command Line (CLI Commands)
```bash
levi models:list              # List all models
levi models:use <name>        # Switch active model
levi models:create [name]     # Interactive CLI creation wizard
levi models:edit <name>       # Edit existing model configuration
levi models:delete <name>     # Delete a model
```

---

## 3. Provider Configuration Guide

### 1. Anthropic Claude (Recommended for Complex Architecture)
• **SDK**: `anthropic`
• **Base URL**: `https://api.anthropic.com`
• **Model ID**: `claude-3-5-sonnet-20241022` or `claude-3-opus-20240229`
• **API Key**: Starts with `sk-ant-api03-...`

### 2. OpenAI
• **SDK**: `openai`
• **Base URL**: `https://api.openai.com/v1`
• **Model ID**: `gpt-4o`, `gpt-4o-mini`, or `o1-preview`
• **API Key**: Starts with `sk-proj-...`

### 3. Google Gemini (via OpenAI Endpoint)
• **SDK**: `openai`
• **Base URL**: `https://generativelanguage.googleapis.com/v1beta/openai/`
• **Model ID**: `gemini-2.0-flash-exp` or `gemini-1.5-pro`
• **API Key**: Google AI Studio API key (`AIzaSy...`)

### 4. Groq (Ultra-Fast Inference)
• **SDK**: `openai`
• **Base URL**: `https://api.groq.com/openai/v1`
• **Model ID**: `llama-3.3-70b-versatile` or `mixtral-8x7b-32768`
• **API Key**: Starts with `gsk_...`

### 5. Ollama (100% Offline Local Models)
Run completely offline without any internet connection or API costs:
1. Start Ollama: `ollama run llama3.3`
2. Register in Levi:
   • **SDK**: `openai`
   • **Base URL**: `http://localhost:11434/v1`
   • **Model ID**: `llama3.3` (or `qwen2.5-coder:32b`, `deepseek-coder:33b`)
   • **API Key**: `ollama` (any placeholder string)

### 6. DeepSeek / OpenRouter / Custom Endpoints
Levi works with any OpenAI-compatible proxy or cloud provider. Set:
• **Base URL**: Your provider's v1 endpoint (e.g. `https://openrouter.ai/api/v1`)
• **Model ID**: Provider's model slug (e.g. `deepseek/deepseek-chat`)

---

## 4. Tips & Optimization

• **Pairing Models with Effort Settings**: High-reasoning models (`claude-3-5-sonnet`, `o1`) excel on `/effort max`. Fast models (`gemini-2.0-flash`, `gpt-4o-mini`, `groq`) excel on `/effort fast`.
• **Checking Status**: Run `/status` in chat anytime to view active model, token usage, and context window limits.
• **Seamless Switching**: You can switch models mid-conversation using `/models:use <name>` without losing your chat history or session context.
