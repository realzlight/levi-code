# Levi Skill System — Walkthrough & Reference

Welcome to the **Levi Multi-File & Folder Skill System**. This guide provides a complete walkthrough of organizing, authoring, and executing custom skills with lazy-loaded context efficiency.

---

## 1. Overview & Core Philosophy

Levi skills are modular, battle-tested playbooks, recipes, and rules stored locally in `~/.levi/SKILLS/`.

### 📂 Nested Folder Architecture
Instead of dumping flat single files into a messy root directory, skills are organized into nested category folders and subfolders:
- `~/.levi/SKILLS/UI-UX-SKILLS/ui.md`
- `~/.levi/SKILLS/UI-UX-SKILLS/ux.md`
- `~/.levi/SKILLS/UI-UX-SKILLS/COMPONENTS/button.md`
- `~/.levi/SKILLS/UI-UX-SKILLS/COMPONENTS/modal.md`
- `~/.levi/SKILLS/BACKEND/API/REST/auth.md`

### ⚡ Progressive Disclosure & Lazy Loading
Skills consume zero unneeded context window tokens:
1. **Catalog Index**: Levi only loads a 1-line summary and file reference into the prompt:
   `- UI-UX-SKILLS/COMPONENTS/button (file: ~/.levi/SKILLS/UI-UX-SKILLS/COMPONENTS/button.md): Accessible button tokens and variants`
2. **On-Demand Activation**: When your request requires the skill, Levi automatically reads the full markdown file on-demand using `read_file()`.
3. **Usage Metrics**: Every time a skill is referenced or loaded, its usage count is tracked and updated.

---

## 2. Command Reference

All skill operations are managed directly from the Levi terminal interface:

### 📖 `/skills`
Opens this full interactive walkthrough guide. Press **Esc** or **q** anytime to return to chat.

### 📋 `/skills:list [folder]`
Displays the complete hierarchical tree of all skill folders, subfolders, and skill files.
- Includes active/disabled badges (`🟢 active` / `❌ disabled`), usage counts, and 1-line summaries.
- Pass an optional folder name to filter (e.g. `/skills:list UI-UX-SKILLS`).

### 📁 `/skills:folder`
Lists all registered skill folders and subfolders without cluttering your view with individual files.
- Shows total skill file counts inside each directory branch.

### ➕ `/skills:new <folder/subfolder>`
Creates a new skill directory or nested subfolder path under `~/.levi/SKILLS/`.
- Examples:
  - `/skills:new UI-UX-SKILLS`
  - `/skills:new UI-UX-SKILLS/COMPONENTS`
  - `/skills:new BACKEND/DATABASE/MIGRATIONS`

### ✍️ `/skills:create <folder> [subfolder] <filename>`
Creates a new `.md` skill file initialized with a structured playbook template.
- Supports any depth of subfolders:
  - `/skills:create UI-UX-SKILLS ui` → `~/.levi/SKILLS/UI-UX-SKILLS/ui.md`
  - `/skills:create UI-UX-SKILLS COMPONENTS button` → `~/.levi/SKILLS/UI-UX-SKILLS/COMPONENTS/button.md`
  - `/skills:create BACKEND API REST auth` → `~/.levi/SKILLS/BACKEND/API/REST/auth.md`
  - Slash notation: `/skills:create UI-UX-SKILLS/COMPONENTS/modal`

### 📝 `/skills:edit <path>`
Launches your terminal editor (`nano` or `$EDITOR`) directly on the target skill file.
- Example: `/skills:edit UI-UX-SKILLS/ui` or `/skills:edit UI-UX-SKILLS/COMPONENTS/button`
- When you exit the editor, Levi automatically reads your instructions, synthesizes a concise 1-line summary, and updates metadata.

### 🔍 `/skills:read <path>` (or `/skills:show <path>`)
Prints the complete raw markdown instructions of a skill directly in the chat panel.
- Example: `/skills:read UI-UX-SKILLS/ui`

### 🗑 `/skills:delete <path>`
Safely removes a skill file or an entire skill directory branch.
- Delete a single skill: `/skills:delete UI-UX-SKILLS/COMPONENTS/button`
- Delete an entire folder branch: `/skills:delete UI-UX-SKILLS/COMPONENTS`

### ⏸ `/skills:disable <path>` & ▶️ `/skills:enable <path>`
Temporarily toggles a skill or entire folder on or off without deleting files.
- Disabled skills are excluded from Levi's lazy-load catalog.
- Toggle an individual skill: `/skills:disable UI-UX-SKILLS/ui`
- Toggle an entire folder: `/skills:disable UI-UX-SKILLS`

### 🧠 `/learn [folder/name]`
Distills the actions and solutions from your recent conversation into a reusable skill file.
- Example: `/learn ANDROID-TERMUX/node-canvas-fix`
- Levi analyzes recent commands, tool calls, and fixes, then formats a ready-to-use playbook.

---

## 3. Skill File Template & Structure

When writing a skill, follow this structured format:

```markdown
# Skill Title

> One sentence describing what this skill does and its trigger conditions.

## When to use
Clear keywords, scenarios, and project conditions when Levi should activate this skill.

## Guidelines & Recipes
- Step 1: Specific commands, configs, or conventions to follow.
- Step 2: Concrete code patterns or templates.
- Common gotchas, traps, and errors to prevent.
```

---

## 4. Quick Cheatsheet

| Task | Command |
| :--- | :--- |
| View walkthrough guide | `/skills` |
| View all folders & skills | `/skills:list` |
| View only folder tree | `/skills:folder` |
| Create new folder | `/skills:new UI-UX-SKILLS/COMPONENTS` |
| Create new skill file | `/skills:create UI-UX-SKILLS COMPONENTS button` |
| Edit skill file | `/skills:edit UI-UX-SKILLS/COMPONENTS/button` |
| View skill content | `/skills:read UI-UX-SKILLS/COMPONENTS/button` |
| Delete skill or folder | `/skills:delete UI-UX-SKILLS/COMPONENTS/button` |
| Toggle active status | `/skills:disable UI-UX-SKILLS` / `/skills:enable UI-UX-SKILLS` |
| Auto-distill recent turn | `/learn UI-UX-SKILLS/animation` |

