# Levi Plugin System — Walkthrough & Reference

Welcome to the **Levi Community Plugin System**. This guide explains how to install, manage, build, and distribute external plugins and playbooks from Git repositories.

---

## 1. Overview & Core Philosophy

Levi separates personal customization from shared community ecosystems:

| System | Storage Path | Purpose & Scope |
| :--- | :--- | :--- |
| **Skills** | `~/.levi/SKILLS/` | **Personal only**. Private recipes, project tricks, custom workflows. No external git cloning or repo fetching. |
| **Plugins** | `~/.levi/PLUGINS/` | **Community & Shared**. External plugins, playbooks, design systems, and domain knowledge installed directly from Git repositories. |

### 🔍 Strict Manifest Verification (`.levi-plugins/plugin.json`)
Every valid Levi plugin repository **MUST** contain a manifest file at:
```
.levi-plugins/plugin.json
```

If this manifest is absent or invalid, Levi rejects the repository during installation to ensure safety and integrity.

### 📦 Manifest Specification
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
- `author`: Author or organization name.
- `plugins` *(required)*: Array of relative file or folder paths inside the repository containing markdown playbooks.

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

### 📥 `/plugin:install <git-url>`
Clones and installs a community plugin from a Git repository:
```bash
/plugin:install https://github.com/levi-community/ui-ux-skills
```
**Installation Lifecycle**:
1. Shallow clones (`--depth 1`) the repository into `~/.levi/PLUGINS/.tmp-...`.
2. Validates `.levi-plugins/plugin.json`.
3. Renames the repository directory to `~/.levi/PLUGINS/<manifest-name>`.
4. Recursively crawls the targets specified in the `plugins` field.
5. Indexes all discovered `.md` files in Hybrid Memory (`documents`, FTS, vectors).
6. Registers metadata in `~/.levi/plugins.json` for lazy-loaded model prompting.

### 📋 `/plugin:list` (or `/plugins:list`)
Displays all installed plugins, authors, versions, and indexed playbooks.

### 🔄 `/plugin:update [name]`
Pulls latest changes from Git for the specified plugin (or all plugins if no name is provided), rescans target files, and refreshes the retrieval database:
```bash
/plugin:update design-system
/plugin:update
```

### 🗑️ `/plugin:remove <name>` (or `/plugin:delete <name>`)
Uninstalls the plugin, deletes its directory from `~/.levi/PLUGINS/<name>`, and removes its entries from the prompt context and search index:
```bash
/plugin:remove design-system
```

---

## 3. Creating Your Own Levi Plugin

Creating and publishing a Levi plugin takes just a few minutes:

1. **Initialize a Git repository**:
   ```bash
   git init my-awesome-plugin
   cd my-awesome-plugin
   mkdir -p .levi-plugins ui-ux-skills video-editing-skills
   ```

2. **Add `.levi-plugins/plugin.json`**:
   ```json
   {
     "name": "awesome-skills",
     "version": "1.0.0",
     "description": "Curated UI and video editing playbooks",
     "author": "your-name",
     "plugins": [
       "./ui-ux-skills",
       "./video-editing-skills"
     ]
   }
   ```

3. **Add markdown playbooks**:
   ```markdown
   # Modern Responsive Design System
   > Production layout grids, typography scales, and Tailwind utility standards.

   ## Guidelines
   - Use rem units for spacing
   - Accessible contrast ratios (WCAG AA)
   ```

4. **Push to GitHub**:
   ```bash
   git add .
   git commit -m "feat: initial plugin release"
   git remote add origin https://github.com/your-username/my-awesome-plugin.git
   git push -u origin main
   ```

5. **Install in Levi**:
   ```bash
   /plugin:install https://github.com/your-username/my-awesome-plugin
   ```
