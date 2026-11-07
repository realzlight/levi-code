# Levi Plugin System — Walkthrough & Reference

Welcome to the **Levi Community Plugin System**. This guide explains how to install, manage, build, and distribute external plugins and playbooks from Git repositories across multiple AI CLI ecosystems.

---

## 1. Overview & Core Philosophy

Levi separates personal customization from shared community ecosystems:

| System | Storage Path | Purpose & Scope |
| :--- | :--- | :--- |
| **Skills** | `~/.levi/SKILLS/` | **Personal only**. Private recipes, project tricks, custom workflows. No external git cloning or repo fetching. |
| **Plugins** | `~/.levi/PLUGINS/` | **Community & Shared**. External plugins, playbooks, design systems, and domain knowledge installed directly from Git repositories. |

### 🔍 Multi-Manifest Architecture (`plugin.json`)
Levi supports native `plugin.json` manifests from **all major AI CLI ecosystems**:

| Ecosystem | Manifest Location | Default Targets |
| :--- | :--- | :--- |
| 🔷 **Levi** | `.levi-plugins/plugin.json`, `.levi/plugin.json` | `./` or `plugins` field |
| 🟠 **Claude Code** | `.claude-plugins/plugin.json`, `.claude/plugin.json`, `.claude-plugin/plugin.json` | `commands`, `skills`, `CLAUDE.md` |
| 🟢 **Codex / OpenAI** | `.codex-plugins/plugin.json`, `.codex/plugin.json`, `.openai/plugin.json` | `agents`, `skills`, `AGENTS.md` |
| 🟣 **Cursor** | `.cursor-plugins/plugin.json`, `.cursor/plugin.json`, `.cursor/rules.json` | `rules`, `.cursorrules`, `.cursor/rules/` |
| 🔵 **Windsurf** | `.windsurf-plugins/plugin.json`, `.windsurf/plugin.json` | `rules`, `.windsurfrules` |
| 🟡 **Cline / Roo Code** | `.cline-plugins/plugin.json`, `.cline/plugin.json`, `.roo-plugins/plugin.json` | `rules`, `modes`, `.clinerules` |
| ⚫ **GitHub Copilot** | `.copilot-plugins/plugin.json`, `.github/plugin.json` | `instructions`, `.github/copilot-instructions.md` |
| 📦 **Standard** | `plugin.json`, `.plugins/plugin.json` | `./` or `plugins` field |

### 🎯 Interactive Manifest Selection
When a repository contains **multiple manifests** (e.g. both a `.levi-plugins/plugin.json` and `.claude-plugins/plugin.json`), Levi scans the repository, detects all options, and opens an **interactive selection modal**:
```
✦ INPUT REQUIRED
Which manifest should Levi use for design-system?

› 🔷 Levi Manifest (.levi-plugins/plugin.json)
  🟠 Claude Code Manifest (.claude-plugins/plugin.json)

↑↓ select · Enter to pick · Esc to cancel
```
You can also override or pre-select the manifest directly in the command:
```bash
/plugin:install https://github.com/owner/repo claude
/plugin:install https://github.com/owner/repo levi
```

### 📦 Manifest Specification (`plugin.json`)
```json
{
  "name": "design-system",
  "version": "1.0.0",
  "description": "Production UI/UX design tokens and playbooks",
  "author": "jane-doe",
  "plugins": [
    "./ui-ux-skills",
    "./video-editing-skills"
  ]
}
```

- `name` *(required)*: Canonical package identifier. Levi automatically renames the cloned repo folder to this name in `~/.levi/PLUGINS/<name>`.
- `version`: Semantic version string.
- `description`: 1-line summary displayed in prompt contexts and command lists.
- `author`: Author name or `{ "name": "...", "url": "..." }`.
- `plugins` / `skills` / `rules` / `commands`: Array of relative paths inside the repository containing playbooks.

### ⚡ Progressive Disclosure & Lazy Loading
1. **Catalog Indexing**: Levi registers the plugin's metadata in `~/.levi/plugins.json` and syncs playbooks into the hybrid retrieval database (`documents`, `documents_fts`, `documents_vec`).
2. **Prompt Efficiency**: Only the plugin name and 1-line summary are loaded into the model's active context:
   `- design-system/ui-ux-skills/components (file: ~/.levi/PLUGINS/design-system/ui-ux-skills/components.md): Design tokens & button specs`
3. **On-Demand Execution**: When your prompt triggers a plugin topic, Levi reads the full playbook on-demand using `read_file()` and executes the instructions.

---

## 2. Command Reference

All plugin operations are executed directly inside the Levi terminal interface:

### 📖 `/plugin` (or `/plugins`)
Opens this interactive fullscreen walkthrough guide. Press **Esc** or **q** anytime to return to chat.

### 📥 `/plugin:install <git-url> [manifest]`
Clones repository, scans for all manifests, and installs playbooks:
```bash
/plugin:install https://github.com/levi-community/ui-ux-skills
/plugin:install https://github.com/owner/repo claude
```

### 📋 `/plugin:list` (or `/plugins:list`)
Displays all installed plugins, format badges (`🔷 Levi`, `🟠 Claude Code`, `🟢 Codex`, etc.), authors, versions, and indexed playbooks.

### 🔄 `/plugin:update [name]`
Pulls latest changes from Git, rescans manifest target paths, and refreshes the retrieval database:
```bash
/plugin:update design-system
/plugin:update
```

### 🗑️ `/plugin:remove <name>` (or `/plugin:delete <name>`)
Uninstalls the plugin, deletes its directory from `~/.levi/PLUGINS/<name>`, and removes its entries from the prompt context and search index:
```bash
/plugin:remove design-system
```
