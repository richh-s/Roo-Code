# Phase 2: Hook Middleware & Security Boundary — Technical Report

**Project:** Roo Code VS Code Extension  
**Author:** Aman  
**Date:** 2026-02-19

---

## Table of Contents

1. [How the VS Code Extension Works](#1-how-the-vs-code-extension-works)
2. [Code & Design Architecture](#2-code--design-architecture)
3. [Phase 1 Recap — Intent-Driven Governance](#3-phase-1-recap--intent-driven-governance)
4. [Phase 2 — Hook Middleware Architecture](#4-phase-2--hook-middleware-architecture)
5. [Architectural Decisions](#5-architectural-decisions)
6. [Diagrams & Schemas](#6-diagrams--schemas)
7. [File Inventory](#7-file-inventory)
8. [Test Results](#8-test-results)

---

## 1. How the VS Code Extension Works

Roo Code is a VS Code extension that provides an AI-powered coding assistant. It creates a conversational interface inside VS Code's sidebar, where a user can describe tasks in natural language and the agent autonomously reads, writes, and executes code on the user's machine.

### 1.1 Extension Lifecycle

When VS Code loads the extension, `activate()` in `src/extension.ts` bootstraps the system:

| Step | Action                                              |
| ---- | --------------------------------------------------- |
| 1    | Create output channel for logging                   |
| 2    | Initialize custom tool registry                     |
| 3    | Initialize telemetry (PostHog)                      |
| 4    | Initialize terminal shell handlers                  |
| 5    | **Create `ClineProvider`** (sidebar webview bridge) |
| 6    | **Register as sidebar webview**                     |
| 7    | **Register all commands**                           |
| 8    | Return public API instance                          |

### 1.2 Message Flow — User to Tool Execution

```
User types message in Webview (React UI)
    → vscodeApi.postMessage({ type: "newTask", text: "..." })
    → Extension Host receives via webview.onDidReceiveMessage
    → webviewMessageHandler() dispatches on message.type
    → case "newTask" → provider.createTask(text)
    → new Task({...}) → recursivelyMakeClineRequests()
    → getSystemPrompt() → SYSTEM_PROMPT() → generatePrompt() (11 sections)
    → attemptApiRequest() → api.createMessage(systemPrompt, history, tools)
    → LLM streams response chunks
    → NativeToolCallParser.processRawChunk() → ToolUse blocks
    → presentAssistantMessage() → validate → switch(block.name)
    → BaseTool.handle() → execute() → askApproval() → perform action
    → pushToolResult() → tool_result sent back → loop continues
```

### 1.3 The Tool Execution Loop

Three gates protect every tool invocation:

| Gate       | Component                     | Purpose                                          |
| ---------- | ----------------------------- | ------------------------------------------------ |
| **Gate 1** | `validateToolUse()`           | Ensures the tool is allowed for the current mode |
| **Gate 2** | `toolRepetitionDetector`      | Blocks identical tool calls in a loop            |
| **Gate 3** | `switch(block.name)` dispatch | Routes to the correct `BaseTool` subclass        |

Three callbacks are threaded through every tool:

- **`askApproval`** — pauses execution for user confirmation
- **`handleError`** — formats errors and feeds them back to the LLM
- **`pushToolResult`** — sends the result into conversation history

### 1.4 The Prompt Builder

The system prompt is regenerated on **every API request**. `generatePrompt()` concatenates 11 sections including role definition, capabilities, tool guidelines, rules, system info, and custom instructions.

---

## 2. Code & Design Architecture

### 2.1 High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              VS Code Extension Host                         │
│                                                                              │
│  ┌────────────┐     ┌───────────────┐     ┌───────────────────────────────┐  │
│  │  Webview    │     │ ClineProvider │     │          Task.ts              │  │
│  │  (React UI) │────►│ (Bridge)      │────►│  recursivelyMakeClineRequests │  │
│  │            │ msg  │               │task │                               │  │
│  └────────────┘     └───────────────┘     │  ┌─ getSystemPrompt()         │  │
│       ▲                                    │  ├─ attemptApiRequest()       │  │
│       │                                    │  │   └─ api.createMessage()───┼──┼──► LLM API
│       │                                    │  ├─ NativeToolCallParser      │  │
│       │                                    │  ├─ presentAssistantMessage() │  │
│       │                                    │  │   └─ BaseTool.handle()     │  │
│       │  askApproval / pushToolResult      │  │       ├─ Phase 1 Gatekeeper│  │
│       ◄────────────────────────────────────┼──┘       ├─ Phase 2 HookEngine│  │
│                                            │          └─ execute()         │  │
│                                            └───────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Key Component Responsibilities

| Component                 | File                                                    | Responsibility                                      |
| ------------------------- | ------------------------------------------------------- | --------------------------------------------------- |
| `ClineProvider`           | `src/core/webview/ClineProvider.ts`                     | Bridge between Webview UI and Extension Host        |
| `Task`                    | `src/core/task/Task.ts`                                 | Main orchestrator: LLM loop, prompt building, state |
| `BaseTool`                | `src/core/tools/BaseTool.ts`                            | Abstract base for all tool handlers                 |
| `presentAssistantMessage` | `src/core/assistant-message/presentAssistantMessage.ts` | Dispatches tool blocks to handlers                  |
| `activeIntents`           | `src/core/context/activeIntents.ts`                     | Phase 1 YAML loading, intent lookup                 |
| `HookEngine`              | `src/hooks/HookEngine.ts`                               | **Phase 2** pre/post-hook pipeline                  |

---

## 3. Phase 1 Recap — Intent-Driven Governance

Phase 1 introduced the **Intent Handshake** — a gatekeeper in `BaseTool.handle()` that blocks destructive tools unless a valid, IN_PROGRESS intent is selected.

**Key concepts:**

- **`.orchestration/active_intents.yaml`** — declares intents with `id`, `goal`, `status`, `constraints`, and `scope`
- **Governed workspace** — any workspace containing `.orchestration/`
- **`SAFE_TOOLS` set** — read-only tools that bypass governance
- **Intent Handshake** — verifies governed workspace, intent selected, status `IN_PROGRESS`
- **Trace logging** — records tool executions per intent

---

## 4. Phase 2 — Hook Middleware Architecture

### 4.1 Requirements

| Req #     | Name                      | Description                                         |
| --------- | ------------------------- | --------------------------------------------------- |
| **REQ-1** | Command Classification    | Distinguish SAFE / SENSITIVE / DESTRUCTIVE          |
| **REQ-2** | UI-Blocking Authorization | Modal Approve/Reject dialog for destructive actions |
| **REQ-3** | Autonomous Recovery       | Standardised JSON tool-error with `suggestedFix`    |
| **REQ-4** | Scope Enforcement         | Pre-hook validates against intent `owned_scope`     |

### 4.2 Three-Tier Command Classification

| Classification  | Enforcement                          | Examples                                                                  |
| --------------- | ------------------------------------ | ------------------------------------------------------------------------- |
| **SAFE**        | Bypasses all enforcement             | `list_files`, `search_files`, `codebase_search`                           |
| **SENSITIVE**   | Authorization only (no scope check)  | `read_file(".env")`, `read_file("*.pem")`, `read_file(".orchestration/")` |
| **DESTRUCTIVE** | Full pipeline: scope → authorization | `write_to_file`, `execute_command`, `apply_diff`                          |

Sensitive detection patterns: `.env`, `.npmrc`, `.netrc`, `id_rsa`, `id_ed25519`, `*.pem`, `*.key`, `*.p12`, `.orchestration/*`, `secrets.*`, `credentials.*`

### 4.3 Three-Layer Boundary Model

Phase 2 introduces three distinct security boundaries, each enforced at a specific gate:

```
Agent → [Intent Gate] → [Scope Gate] → [Human Gate] → Execution
         Phase 1          Phase 2         Phase 2
```

| Boundary                | Layer               | Question Answered                                |
| ----------------------- | ------------------- | ------------------------------------------------ |
| **Intent Boundary**     | Phase 1 Gatekeeper  | "Has the agent declared what it's doing?"        |
| **Scope Boundary**      | Scope Enforcer Hook | "Is this file within the intent's allowed area?" |
| **Human Authorization** | Authorization Hook  | "Does the user approve this specific action?"    |

### 4.4 Path Traversal Prevention

Before scope matching, all paths are security-normalised:

1. **Resolve**: `path.resolve(cwd, targetPath)` — normalises `../`, `./`, etc.
2. **Boundary check**: `resolved.startsWith(cwd)` — rejects paths outside workspace
3. **Convert**: `path.relative(cwd, resolved)` → workspace-relative POSIX path

Blocked examples: `../config/database.ts`, `/etc/passwd`, `../../.ssh/id_rsa`

### 4.5 Error Payload Schema (REQ-3)

All blocking hooks return a standardised JSON string with a `suggestedFix` field:

```json
{
	"status": "error",
	"message": "Scope Violation: refactor-auth is not authorized to edit src/billing/invoice.ts. Allowed scope: [src/auth/**].",
	"error": {
		"code": "SCOPE_VIOLATION",
		"details": {
			"intentId": "refactor-auth",
			"filePath": "src/billing/invoice.ts",
			"allowedScope": ["src/auth/**"],
			"requestedPath": "src/billing/invoice.ts"
		},
		"suggestedFix": "Ask the user to expand the scope or select a different intent that owns this file."
	}
}
```

### 4.6 Scope Expansion Workflow

When a scope violation occurs, the user sees a **3-button modal**:

| Button                     | Effect                                                           |
| -------------------------- | ---------------------------------------------------------------- |
| **Reject**                 | Block the action, return error to LLM                            |
| **Approve Once**           | One-time bypass, will block again next time                      |
| **Approve & Expand Scope** | Bypass + write expansion request to `pending_scope_updates.json` |

The expansion request is written to `.orchestration/pending_scope_updates.json` — **the YAML is never auto-edited**, preserving the trust boundary. A human or CI process reviews and applies pending expansions.

### 4.7 `.intentignore` Mechanism

A `.intentignore` file at the workspace root exempts paths from scope enforcement:

| Pattern  | Example        | Matches                             |
| -------- | -------------- | ----------------------------------- |
| Prefix   | `dist/`        | `dist/index.js`, `dist/lib/util.js` |
| Suffix   | `*.log`        | `app.log`, `src/debug.log`          |
| Contains | `node_modules` | `foo/node_modules/bar.js`           |
| Exact    | `package.json` | `package.json` only                 |

### 4.8 Integration Point — `BaseTool.handle()`

11-line patch, placed **after** Phase 1 gatekeeper and **before** `execute()`:

```typescript
if (!SAFE_TOOLS.has(this.name) && isGovernedWorkspace(task.cwd)) {
	const hookCtx = buildHookContext(this.name, (params ?? {}) as Record<string, unknown>, task)
	const hookResult = await hookEngine.runPre(hookCtx)
	if (!hookResult.proceed) {
		callbacks.pushToolResult(formatResponse.toolError(hookResult.error ?? "Blocked by Hook Engine."))
		return
	}
}
```

---

## 5. Architectural Decisions

### ADR-1: Interception Point — `BaseTool.handle()`

**Decision**: Hook into `BaseTool.handle()` rather than `presentAssistantMessage()`.  
**Rationale**: Single funnel for all native tools. Phase 1 gatekeeper lives here, so Phase 2 hooks naturally extend the same chain.

### ADR-2: Composable Pipeline with Short-Circuit

**Decision**: Ordered pre-hook pipeline where first failure blocks.  
**Rationale**: SRP (each hook has one job), OCP (`addPreHook()` for extensions), clean test isolation via `clearHooks()`.

### ADR-3: Scope Before Authorization

**Decision**: Scope enforcer runs before authorization dialog.  
**Rationale**: Out-of-scope writes are deterministic rejections — no need to waste user attention.

### ADR-4: Three-Tier Classification (SAFE / SENSITIVE / DESTRUCTIVE)

**Decision**: Add SENSITIVE tier for read-only operations on secret files.  
**Rationale**: `read_file(".env")` is read-only but leaks secrets. SENSITIVE tools skip scope enforcement (they don't modify files) but require user authorization.

### ADR-5: Path Traversal Normalization

**Decision**: `path.resolve()` + workspace boundary check before any scope matching.  
**Rationale**: Without normalization, `../config.ts` or absolute paths bypass scope. This turns REQ-001 into a real security boundary.

### ADR-6: No Auto-Edit of YAML

**Decision**: Scope expansion writes to `pending_scope_updates.json`, never modifies `active_intents.yaml`.  
**Rationale**: Auto-editing the governance config would break the trust boundary. Expansions are proposals that a human reviews.

### ADR-7: Richer Error Payloads with `suggestedFix`

**Decision**: All error payloads include what failed, why, and how to fix it.  
**Rationale**: LLMs self-correct much better when given actionable guidance rather than just an error code.

---

## 6. Diagrams & Schemas

### 6.1 Tool Execution Flow — Phase 1 + Phase 2

```
┌────────────────────────────────────────────────────────────────┐
│                    BaseTool.handle()                            │
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Phase 1: Intent Handshake Gatekeeper                    │  │
│  │  SAFE? → skip   |   Governed? → check intent             │  │
│  │  No intent → BLOCK   |   Not IN_PROGRESS → BLOCK         │  │
│  └──────────────────────┬───────────────────────────────────┘  │
│                         ▼                                      │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Phase 2: Hook Engine                                    │  │
│  │                                                          │  │
│  │  Classify: SAFE → skip | SENSITIVE → auth only            │  │
│  │           DESTRUCTIVE → full pipeline                     │  │
│  │                                                          │  │
│  │  ┌─ Path Normalisation ──┐                               │  │
│  │  │ path.resolve()        │                               │  │
│  │  │ Workspace boundary    │                               │  │
│  │  │ TRAVERSAL → BLOCK     │                               │  │
│  │  └────────────┬──────────┘                               │  │
│  │               ▼                                          │  │
│  │  ┌─ Scope Enforcer ──────┐                               │  │
│  │  │ .intentignore check    │                               │  │
│  │  │ Scope glob matching    │                               │  │
│  │  │ OUT-OF-SCOPE:          │                               │  │
│  │  │  [Reject|Once|Expand]  │                               │  │
│  │  └────────────┬──────────┘                               │  │
│  │               ▼                                          │  │
│  │  ┌─ Authorization ───────┐                               │  │
│  │  │ showWarningMessage()   │                               │  │
│  │  │  [Approve] [Reject]    │                               │  │
│  │  └────────────┬──────────┘                               │  │
│  └───────────────┼──────────────────────────────────────────┘  │
│                  ▼                                              │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  execute()  →  Filesystem / Terminal                     │  │
│  └──────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘
```

### 6.2 Module Dependency Graph

```
BaseTool.ts
    │
    └──► src/hooks/index.ts (barrel)
             │
             ├──► HookEngine.ts
             │       ├──► commandClassifier.ts (classifyWithPath + isSensitivePath)
             │       ├──► scopeEnforcer.ts
             │       │       ├──► intentIgnore.ts
             │       │       ├──► toolError.ts
             │       │       ├──► pendingScopeUpdates.ts
             │       │       └──► activeIntents.ts (Phase 1)
             │       ├──► authorizationHook.ts
             │       │       └──► toolError.ts
             │       └──► activeIntents.ts (isGovernedWorkspace)
             │
             └──► types.ts
```

### 6.3 Failure Mode Matrix

| Scenario                | Blocking Layer     | Error Code               | Recovery Behavior                    |
| ----------------------- | ------------------ | ------------------------ | ------------------------------------ |
| No intent selected      | Phase 1 Gatekeeper | `NO_ACTIVE_INTENT`       | LLM calls `select_active_intent`     |
| Intent PAUSED/COMPLETED | Phase 1 Gatekeeper | `INTENT_LOCKED`          | LLM selects different intent         |
| Path traversal (`../`)  | Scope Enforcer     | `PATH_TRAVERSAL`         | LLM uses workspace-relative path     |
| Out-of-scope file       | Scope Enforcer     | `SCOPE_VIOLATION`        | User chooses: Reject / Once / Expand |
| Sensitive read (`.env`) | Authorization Hook | `SENSITIVE_READ_BLOCKED` | LLM asks user for specific values    |
| User rejects action     | Authorization Hook | `AUTHORIZATION_REJECTED` | LLM revises approach                 |
| YAML missing/corrupt    | Scope Enforcer     | `GRACEFUL_FALLBACK`      | Operate without scope enforcement    |
| Prompt too large        | Prompt Builder     | `PROMPT_REBUILD`         | Stateless recovery                   |

### 6.4 Data Flow Trace

```
LLM emits JSON tool_call chunk
    │
    ▼
NativeToolCallParser.processRawChunk()
    │
    ▼
ToolUse<T> block (typed, complete)
    │
    ▼
presentAssistantMessage() → validate → switch(block.name)
    │
    ▼
BaseTool.handle(task, block, callbacks)
    │
    ├─ Phase 1: gatekeeper validation
    │
    ├─ buildHookContext(toolName, params, task)
    │      → HookContext { toolName, params, cwd, activeIntentId }
    │
    ├─ hookEngine.runPre(ctx)
    │      ├─ classifyWithPath() → SAFE / SENSITIVE / DESTRUCTIVE
    │      ├─ normaliseAndValidatePath() → relative path or PATH_TRAVERSAL
    │      ├─ scopeEnforcerHook() → scope check + 3-button modal
    │      └─ authorizationHook() → Approve/Reject dialog
    │      → HookResult { proceed, error?, reason? }
    │
    ├─ if !proceed: formatResponse.toolError(result.error)
    │      → JSON string pushed as tool_result
    │      → LLM receives error in conversation history
    │      → LLM reads suggestedFix and self-corrects
    │
    └─ if proceed: execute(params, task, callbacks)
           → Filesystem / Terminal action
           → pushToolResult(output)
           → Trace event recorded
```

---

## 7. File Inventory

### Phase 2 — Files

| File                     | Path                                     | Purpose                                                        |
| ------------------------ | ---------------------------------------- | -------------------------------------------------------------- |
| `types.ts`               | `src/hooks/types.ts`                     | Core types (3-tier `ToolClassification`)                       |
| `commandClassifier.ts`   | `src/hooks/commandClassifier.ts`         | `classifyWithPath`, `isSensitivePath`, sensitive patterns      |
| `toolError.ts`           | `src/hooks/toolError.ts`                 | Error builders with `suggestedFix`, 6 error codes              |
| `intentIgnore.ts`        | `src/hooks/intentIgnore.ts`              | `.intentignore` loader and matcher                             |
| `scopeEnforcer.ts`       | `src/hooks/scopeEnforcer.ts`             | Path traversal prevention + scope enforcement + 3-button modal |
| `authorizationHook.ts`   | `src/hooks/authorizationHook.ts`         | UI-blocking Approve/Reject dialog                              |
| `HookEngine.ts`          | `src/hooks/HookEngine.ts`                | Central orchestrator (SAFE/SENSITIVE/DESTRUCTIVE routing)      |
| `pendingScopeUpdates.ts` | `src/hooks/pendingScopeUpdates.ts`       | Scope expansion recording to `pending_scope_updates.json`      |
| `index.ts`               | `src/hooks/index.ts`                     | Barrel export                                                  |
| `HookEngine.spec.ts`     | `src/hooks/__tests__/HookEngine.spec.ts` | Comprehensive unit tests                                       |

### Modified Files

| File                         | Change                               |
| ---------------------------- | ------------------------------------ |
| `src/core/tools/BaseTool.ts` | +1 import, +11 lines for hook wiring |

---

## 8. Test Results

All Phase 2 hook engine tests pass. Phase 1 regression tests pass (no regressions).

---

_End of report._
