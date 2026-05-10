# Opal Code: Multi-Agent Improvement Plan

This document outlines the distributed work plan to implement the 6 major improvements to Opal Code. The work is divided into 3 concurrent workstreams to be handled by Gemini (Me), Claude, and Copilot.

## Workstream 1: Core Engine & Routing (Assigned to: Gemini - Me)
**Scope:** Deep architectural refactoring of the API layer and routing logic.
1.  **Unified Provider Abstraction:** Refactoring `openaiShim.ts` and `claude.ts` into a clean Strategy Pattern.
2.  **TypeScript Smart Router:** Porting `python/smart_router.py` into a native TypeScript module (`src/services/api/smartRouter.ts`).

*You do not need to copy-paste a prompt for me; just give me the go-ahead, and I will begin executing Workstream 1 right here in our current session.*

---

## Workstream 2: Extension & Advanced Tooling (Assigned to: Claude)
**Scope:** Enhancing the IDE experience and adding complex agentic capabilities.
1.  **VS Code Lens Integration:** Adding Code Lens support to `vscode-extension/opalcode-vscode` for inline "Ask Opal" functionality.
2.  **Proactive Tooling:** Creating a "Janitor Agent" for local context summarization and a Playwright-based Vision UI debugging tool.

**Prompt to copy-paste to Claude:**
```text
Context: We are upgrading an open-source CLI coding agent called "Opal Code" (located in the current workspace). It is written in TypeScript and runs on Bun.

Your Assignment: 
You are responsible for "Workstream 2: Extension & Advanced Tooling". Please execute the following two tasks:

1. VS Code Extension Enhancements:
Navigate to `vscode-extension/opalcode-vscode/`. Implement a VS Code "Code Lens" provider that displays an "Ask Opal" link above function declarations and class definitions. When clicked, it should grab the code block's text and pass it to the Opal Code CLI or extension state for a targeted prompt.

2. Proactive Tooling:
- Create a new tool in `src/tools/` called `SummarizeContextTool`. It should act as a "Janitor Agent", hooking into local models (like Ollama or Atomic Chat) to summarize older conversation history when context gets too large.
- Create a new tool in `src/tools/` called `VisionUIDebuggerTool`. Use Playwright to take a screenshot of a user's running dev server and return it as a base64 image block so the agent can debug UI issues.

Please start by investigating `vscode-extension/opalcode-vscode/src/extension.js` and the `src/tools/` directory. Create a brief strategy for your implementation, then proceed to write the code.
```

---

## Workstream 3: CLI Performance & Diagnostics (Assigned to: Copilot)
**Scope:** System-level optimizations, CLI health checks, and utilizing Bun's native APIs.
1.  **Bun-Native Performance:** Migrate file operations in `FileReadTool.ts` and `FileWriteTool.ts` to `Bun.file().text()` and `Bun.write()`. Update `scripts/build.ts` to include a `bun build --compile` target for a single-file binary.
2.  **UX: Opal Doctor:** Implement an `opalcode doctor` command that pings configured providers, checks system dependencies (like `rg`), and validates local LLM health.

**Prompt to copy-paste to Copilot:**
```text
Context: We are upgrading an open-source CLI coding agent called "Opal Code" (located in the current workspace). It is written in TypeScript and runs on Bun.

Your Assignment:
You are responsible for "Workstream 3: CLI Performance & Diagnostics". Please execute the following two tasks:

1. Bun-Native Performance:
- Update `src/tools/FileReadTool/` and `src/tools/FileWriteTool/` to utilize native `Bun.file().text()` and `Bun.write()` for faster I/O.
- Modify the build system (look in `scripts/build.ts` and `package.json`) to add a target that uses `bun build --compile` to generate a standalone executable binary.
- Migrate the session history storage mechanism to use `Bun.sqlite` instead of plain JSON file parsing if applicable.

2. UX: Opal Doctor:
- Create a new command in `src/commands/` (or update existing diagnostics) to implement an interactive `opalcode doctor` CLI command.
- The doctor command should check for system dependencies (e.g., `ripgrep`), ping all providers configured in the user's environment, and check the health of local instances like Ollama or Atomic Chat.

Please investigate the `src/tools/`, `scripts/`, and `src/commands/` directories to formulate your plan, then implement the changes.
```