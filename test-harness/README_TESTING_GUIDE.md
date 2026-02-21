# Phase 1 & Phase 2 — Complete Testing Guide

This guide covers **every** governance feature across both phases.  
All tests use the `test-harness/` workspace.

---

## Prerequisites

### 1. Build & Launch the Extension

```bash
cd /Users/aman/Desktop/projects/10academy/Roo-Code
npm run build
```

Then press **F5** in VS Code to launch the Extension Development Host.

### 2. Open the Test Harness Workspace

In the Extension Development Host:

```
File → Open Folder → test-harness/
```

### 3. Verify the workspace structure exists

```
test-harness/
├── .orchestration/
│   └── active_intents.yaml      ← Governance config
├── .intentignore                 ← Scope exemptions
├── src/
│   ├── auth/
│   │   ├── login.ts
│   │   └── register.ts
│   ├── billing/
│   │   └── invoice.ts
│   └── shared/
│       └── utils.ts
└── .env                          ← Sensitive file (create for testing)
```

### 4. Create the `.env` file for Phase 2 sensitive-read tests

```bash
echo 'DATABASE_URL=postgres://admin:s3cret@localhost:5432/mydb' > test-harness/.env
echo 'API_SECRET=sk-live-abc123xyz' >> test-harness/.env
```

### 5. Verify intent config

```yaml
# .orchestration/active_intents.yaml
intents:
    - id: "refactor-auth"
      status: IN_PROGRESS # ← Active
      scope: ["src/auth/*"]

    - id: "optimize-billing"
      status: PAUSED # ← Inactive
      scope: ["src/billing/*"]
```

---

## Run Automated Unit Tests

Before manual testing, verify all unit tests pass:

```bash
cd /Users/aman/Desktop/projects/10academy/Roo-Code/src
./node_modules/.bin/vitest run hooks/__tests__/HookEngine.spec.ts --reporter verbose
```

**Expected output:**

```
 ✓ commandClassifier > classifyWithPath > returns sensitive for read_file on .env
 ✓ scopeEnforcer > normaliseAndValidatePath > blocks parent traversal (../)
 ✓ scopeEnforcer > scopeEnforcerHook > allows one-time bypass on 'Approve Once'
 ...
 Test Files  1 passed (1)
      Tests  69 passed (69)
```

Also run Phase 1 unit tests:

```bash
cd /Users/aman/Desktop/projects/10academy/Roo-Code/src
./node_modules/.bin/vitest run core/context/__tests__/activeIntents.spec.ts --reporter verbose
```

---

## PHASE 1: Intent Handshake Tests

---

### Test 1 ▸ No Intent Declared → Destructive Tool Blocked

**What it proves:** The Gatekeeper blocks all destructive tools when no intent is selected.

**Steps:**

1. Open Roo-Code sidebar in the Extension Dev Host
2. Ensure `test-harness/` is the workspace root
3. **Do NOT select any intent**
4. Type: _"Add input sanitization to login.ts"_
5. Wait for the agent to attempt a `write_to_file` or `apply_diff`

**Expected output:**

```
❌ Tool call BLOCKED by Gatekeeper
Error in tool_result:
  "No active Intent selected. You must call select_active_intent(intent_id)
   before using destructive tools. Available IN_PROGRESS intents: [refactor-auth]."
```

- No file is modified
- `consecutiveMistakeCount` increments
- Agent should self-correct by calling `select_active_intent`

---

### Test 2 ▸ Valid Intent → Tools Execute Successfully

**What it proves:** After selecting an IN_PROGRESS intent, destructive tools work within scope.

**Steps:**

1. Type: _"Select intent refactor-auth, then add input validation to the login function"_
2. Watch for the agent to call `select_active_intent("refactor-auth")`
3. Then it should call `write_to_file` on `src/auth/login.ts`

**Expected output — Step 1 (intent selection):**

```xml
<intent_context>
  <intent_id>refactor-auth</intent_id>
  <goal>Refactor authentication module for improved maintainability</goal>
  <status>IN_PROGRESS</status>
  <constraints>
    <constraint>Do not modify public API</constraint>
    <constraint>Preserve existing function signatures</constraint>
  </constraints>
  <scope>
    <pattern>src/auth/*</pattern>
  </scope>
</intent_context>
```

**Expected output — Step 2 (tool execution):**

```
✅ Phase 1 Gatekeeper: PASS (intent "refactor-auth" is IN_PROGRESS)
✅ Phase 2 Hook Engine:
   - Classification: DESTRUCTIVE
   - Scope Enforcer: PASS (src/auth/login.ts matches src/auth/*)
   - Authorization: modal appears → click "Approve"
✅ Tool executes successfully
✅ Trace event recorded with outcome: "success"
```

---

### Test 3 ▸ PAUSED Intent → Selection Rejected

**What it proves:** Only IN_PROGRESS intents can be selected.

**Steps:**

1. Type: _"Select intent optimize-billing and refactor invoice.ts"_
2. Watch for the agent to call `select_active_intent("optimize-billing")`

**Expected output:**

```
❌ Intent Selection REJECTED

  "Intent \"optimize-billing\" has status \"PAUSED\" — only IN_PROGRESS intents
   can be selected. Available IN_PROGRESS intents: [refactor-auth]."
```

- `activeIntentId` remains `undefined`
- No file modifications

---

### Test 4 ▸ YAML Changed Mid-Session → Stale Intent Cleared

**What it proves:** The Gatekeeper re-reads YAML on every destructive call — never caches stale data.

**Steps:**

1. First complete Test 2 (agent has `refactor-auth` selected)
2. **While the session is active**, open `.orchestration/active_intents.yaml`
3. Change `refactor-auth` status from `IN_PROGRESS` to `COMPLETED`
4. Save the file
5. Ask the agent: _"Also add logging to register.ts"_

**Expected output:**

```
❌ Tool call BLOCKED — stale intent detected

  "Intent \"refactor-auth\" has status \"COMPLETED\" (must be IN_PROGRESS).
   Active intent has been cleared. No IN_PROGRESS intents available."
```

- `activeIntentId` cleared to `undefined`
- Agent must re-select an intent (but none are available)

**Reset:** Change `refactor-auth` back to `IN_PROGRESS` in the YAML.

---

### Test 5 ▸ No `.orchestration/` Folder → Ungoverned Mode

**What it proves:** Without `.orchestration/`, the workspace is ungoverned and all tools run freely.

**Steps:**

1. Temporarily rename the folder:
    ```bash
    mv test-harness/.orchestration test-harness/.orchestration_backup
    ```
2. Ask the agent: _"Edit login.ts to add a console log"_

**Expected output:**

```
✅ isGovernedWorkspace() returns false
✅ Gatekeeper SKIPPED — no governance
✅ Hook Engine SKIPPED — no governance
✅ Tool executes freely, no approval needed
```

**Reset:**

```bash
mv test-harness/.orchestration_backup test-harness/.orchestration
```

---

### Test 6 ▸ Safe Tools Run Without Intent

**What it proves:** Read-only tools (SAFE classification) bypass all enforcement.

**Steps:**

1. Ensure `.orchestration/` exists (governed mode)
2. **Do NOT select any intent**
3. Type: _"Read the contents of src/shared/utils.ts"_

**Expected output:**

```
✅ classifyWithPath("read_file", {path: "src/shared/utils.ts"}) → "safe"
✅ Gatekeeper: SKIPPED (safe tool)
✅ Hook Engine: SKIPPED (safe classification)
✅ File contents returned normally — no intent needed
```

---

## PHASE 2: Hook Engine Hardening Tests

---

### Test 7 ▸ SENSITIVE Read Detection (.env)

**What it proves:** `read_file(".env")` is classified as SENSITIVE and triggers an authorization dialog (not SAFE).

**Steps:**

1. Select intent `refactor-auth` first
2. Type: _"Read the .env file to check database configuration"_
3. Agent calls `read_file` with `path: ".env"`

**Expected output:**

```
✅ classifyWithPath("read_file", {path: ".env"}) → "sensitive"
⚠️ Authorization dialog appears:

  ┌──────────────────────────────────────────────────────────────┐
  │ [Intent Governance] The agent wants to execute "read_file"   │
  │ under intent "refactor-auth".                                │
  │                                                              │
  │ Tool parameters:                                             │
  │   path: .env                                                 │
  │                                                              │
  │ Do you approve this action?                                  │
  │                                                              │
  │              [Approve]    [Reject]                            │
  └──────────────────────────────────────────────────────────────┘
```

- Click **Approve** → file contents returned
- Click **Reject** → error with `AUTHORIZATION_REJECTED` code

---

### Test 8 ▸ SENSITIVE Read on `.pem` / `.key` Files

**What it proves:** Certificate and key files also trigger SENSITIVE classification.

**Steps:**

1. Create a test key file:
    ```bash
    echo "-----BEGIN RSA PRIVATE KEY-----" > test-harness/server.pem
    ```
2. Type: _"Read the server.pem file"_

**Expected output:**

```
✅ classifyWithPath("read_file", {path: "server.pem"}) → "sensitive"
⚠️ Authorization dialog appears — same as Test 7
```

**Cleanup:** `rm test-harness/server.pem`

---

### Test 9 ▸ Scope Enforcement — In-Scope File Approved

**What it proves:** Files within the intent's scope pass scope enforcement.

**Steps:**

1. Select intent `refactor-auth` (scope: `src/auth/*`)
2. Type: _"Add a comment to src/auth/login.ts"_
3. Agent calls `write_to_file` with `path: "src/auth/login.ts"`

**Expected output:**

```
✅ Path Normalization: "src/auth/login.ts" → within workspace ✓
✅ Scope Check: "src/auth/login.ts" matches "src/auth/*" ✓
⚠️ Authorization dialog appears → click "Approve"
✅ File modified successfully
```

---

### Test 10 ▸ Scope Enforcement — Out-of-Scope File (3-Button Modal)

**What it proves:** Editing files outside the intent's scope shows the 3-button scope violation dialog.

**Steps:**

1. Select intent `refactor-auth` (scope: `src/auth/*`)
2. Type: _"Also fix a bug in src/billing/invoice.ts"_
3. Agent calls `write_to_file` with `path: "src/billing/invoice.ts"`

**Expected output:**

```
❌ Scope Check: "src/billing/invoice.ts" does NOT match "src/auth/*"

⚠️ 3-button modal appears:

  ┌──────────────────────────────────────────────────────────────────┐
  │ [Scope Violation] Intent "refactor-auth" attempted to edit      │
  │ "src/billing/invoice.ts".                                       │
  │                                                                  │
  │ Allowed scope: [src/auth/*]                                      │
  │                                                                  │
  │ How would you like to proceed?                                   │
  │                                                                  │
  │    [Reject]    [Approve Once]    [Approve & Expand Scope]        │
  └──────────────────────────────────────────────────────────────────┘
```

**Sub-test 10a — Click "Reject":**

```
❌ Tool BLOCKED
Error in tool_result:
{
  "status": "error",
  "message": "Scope Violation: refactor-auth is not authorized to edit src/billing/invoice.ts...",
  "error": {
    "code": "SCOPE_VIOLATION",
    "details": { "intentId": "refactor-auth", "filePath": "src/billing/invoice.ts", ... },
    "suggestedFix": "Ask the user to expand the scope or select a different intent..."
  }
}
```

**Sub-test 10b — Click "Approve Once":**

```
✅ One-time bypass — tool proceeds
⚠️ Next time the same file is targeted, the modal appears again
```

**Sub-test 10c — Click "Approve & Expand Scope":**

```
✅ Tool proceeds
✅ File created: .orchestration/pending_scope_updates.json

Contents:
[
  {
    "intentId": "refactor-auth",
    "newPattern": "src/billing/*",
    "filePath": "src/billing/invoice.ts",
    "timestamp": "2026-02-20T...",
    "approvedBy": "user"
  }
]
```

Verify: `cat test-harness/.orchestration/pending_scope_updates.json`

---

### Test 11 ▸ Path Traversal Blocked

**What it proves:** `../` and absolute paths outside the workspace are intercepted and blocked before any scope check.

**Steps:**

1. Select intent `refactor-auth`
2. Type: _"Write a config file to ../config/database.ts"_
3. Agent calls `write_to_file` with `path: "../config/database.ts"`

**Expected output:**

```
❌ Path Traversal BLOCKED (before scope check or auth dialog)

Error in tool_result:
{
  "status": "error",
  "message": "Path Traversal Blocked: \"../config/database.ts\" resolves outside the workspace root...",
  "error": {
    "code": "PATH_TRAVERSAL",
    "details": { "requestedPath": "../config/database.ts", "workspaceRoot": "/path/to/test-harness" },
    "suggestedFix": "Use a workspace-relative path instead of absolute or parent-traversal paths..."
  }
}
```

- No modal dialog appears (blocked immediately)
- No file created outside workspace

---

### Test 12 ▸ `.intentignore` Bypass

**What it proves:** Files matching `.intentignore` patterns bypass scope enforcement.

**Steps:**

1. Confirm `.intentignore` contains:
    ```
    dist/*
    node_modules/*
    *.log
    ```
2. Select intent `refactor-auth` (scope: `src/auth/*`)
3. Type: _"Create a dist/bundle.js file"_
4. Agent calls `write_to_file` with `path: "dist/bundle.js"`

**Expected output:**

```
✅ .intentignore match: "dist/bundle.js" matches pattern "dist/*"
✅ Scope enforcement SKIPPED (exempt file)
⚠️ Authorization dialog appears (still requires human approval)
   → click "Approve"
✅ File created
```

---

### Test 13 ▸ `suggestedFix` in Error Payloads

**What it proves:** Every error includes actionable guidance for LLM self-correction.

**Steps:**

This is verified automatically in the tests above. For every blocked action, check the JSON error in the tool_result:

| Scenario                        | Verify `suggestedFix` Contains                    |
| ------------------------------- | ------------------------------------------------- |
| Scope violation (Test 10a)      | `"expand the scope or select a different intent"` |
| Path traversal (Test 11)        | `"workspace-relative path"`                       |
| Auth rejected (Test 7 + Reject) | `"different approach"`                            |

---

### Test 14 ▸ Authorization Hook — Approve vs Reject

**What it proves:** The modal truly blocks the Promise chain until the user responds.

**Steps:**

1. Select intent `refactor-auth`
2. Type: _"Edit login.ts to add error logging"_
3. When the authorization dialog appears, **wait 10 seconds** before clicking

**Expected output:**

```
⚠️ Dialog appears and agent PAUSES
   (no file changes happen while dialog is open)

Click "Approve" → tool resumes and modifies the file
Click "Reject"  → tool_result contains AUTHORIZATION_REJECTED error
Dismiss (Escape) → treated as rejection
```

---

## Summary Table

| #   | Test                         | Phase | Feature Tested           | Expected               |
| --- | ---------------------------- | ----- | ------------------------ | ---------------------- |
| 1   | No intent + destructive tool | P1    | Gatekeeper               | ❌ Blocked             |
| 2   | Valid intent + in-scope edit | P1+P2 | Handshake + Scope + Auth | ✅ Executes            |
| 3   | PAUSED intent selection      | P1    | Intent validation        | ❌ Rejected            |
| 4   | YAML changed mid-session     | P1    | Live revalidation        | ❌ Stale cleared       |
| 5   | No `.orchestration/` folder  | P1    | Ungoverned mode          | ✅ Free execution      |
| 6   | Safe tool, no intent         | P1+P2 | SAFE classification      | ✅ Free execution      |
| 7   | `read_file(".env")`          | P2    | SENSITIVE classification | ⚠️ Auth dialog         |
| 8   | `read_file("*.pem")`         | P2    | SENSITIVE classification | ⚠️ Auth dialog         |
| 9   | In-scope write               | P2    | Scope enforcer           | ✅ Passes scope        |
| 10  | Out-of-scope write           | P2    | 3-button modal           | ⚠️ Reject/Once/Expand  |
| 11  | Path traversal (`../`)       | P2    | Path normalization       | ❌ Immediate block     |
| 12  | `.intentignore` file         | P2    | Scope exemption          | ✅ Bypasses scope      |
| 13  | Error payloads               | P2    | `suggestedFix` field     | ✅ Actionable guidance |
| 14  | Approve/reject timing        | P2    | Promise blocking         | ⚠️ Blocks until click  |

---

## Troubleshooting

| Problem                                  | Solution                                                                                      |
| ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| Extension not loading                    | Press **F5** to relaunch dev host; check Output → "Roo Code"                                  |
| No governance errors                     | Verify `.orchestration/` exists in the **workspace root**                                     |
| Tests report wrong classification        | Run unit tests: `cd src && ./node_modules/.bin/vitest run hooks/__tests__/HookEngine.spec.ts` |
| `pending_scope_updates.json` not created | Ensure `.orchestration/` directory exists and is writable                                     |
| Authorization dialog not appearing       | Check that the tool is classified as DESTRUCTIVE or SENSITIVE, not SAFE                       |

---

## Run Phase 3 Automated Tests

```bash
cd /Users/aman/Desktop/projects/10academy/Roo-Code/src
./node_modules/.bin/vitest run hooks/__tests__/phase3.spec.ts --reporter verbose
```

**Expected output:**

```
 ✓ contentHash — sha256 > returns expected 64-char hex for 'hello'
 ✓ pathNormalize — canonicalizePath > normalizes ./prefix
 ✓ mutationClassifier > returns INTENT_EVOLUTION for empty ledger
 ✓ mutationClassifier > ignores DELETE entries for classification
 ✓ traceSerializerHook > writes valid JSONL for successful write_to_file
 ✓ traceSerializerHook > detects delete tool by toolName
 ...
 Test Files  1 passed (1)
      Tests  26 passed (26)
```

---

## PHASE 3: Trace Ledger Tests

> **What Phase 3 does:** Every write-class tool execution appends a cryptographically signed trace entry to `.orchestration/agent_trace.jsonl`. This converts ephemeral writes into a verifiable semantic ledger.

---

### Test 15 ▸ First Write Creates Ledger File

**What it proves:** The trace serializer auto-creates `.orchestration/agent_trace.jsonl` on first write.

**Steps:**

1. Delete ledger if it exists:
    ```bash
    rm -f test-harness/.orchestration/agent_trace.jsonl
    ```
2. Select intent `refactor-auth`
3. Type: _"Add input validation to login.ts"_
4. After the agent writes the file, inspect:
    ```bash
    cat test-harness/.orchestration/agent_trace.jsonl | python3 -m json.tool
    ```

**Expected output:**

```json
{
    "id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "timestamp": "2026-02-20T...",
    "tool": "write_to_file",
    "intentId": "refactor-auth",
    "mutationClass": "INTENT_EVOLUTION",
    "mutationType": "WRITE",
    "filePath": "src/auth/login.ts",
    "contentHash": "<64-char hex string>",
    "outcome": "success",
    "revisionId": "<git HEAD hash>",
    "fileSizeBytes": <number>,
    "toolArgsSnapshot": { "path": "src/auth/login.ts" }
}
```

**Verify:**

- ✅ `id` is a valid UUID
- ✅ `contentHash` is 64 chars (SHA-256)
- ✅ `mutationClass` is `"INTENT_EVOLUTION"` (first touch)
- ✅ `mutationType` is `"WRITE"`
- ✅ `fileSizeBytes` matches actual file size: `wc -c test-harness/src/auth/login.ts`
- ✅ `toolArgsSnapshot` has `path` only (no content)

---

### Test 16 ▸ Re-edit → AST_REFACTOR Classification

**What it proves:** The classifier detects subsequent writes by the same intent to the same file.

**Steps:**

1. Immediately after Test 15, type: _"Now add error handling to login.ts"_
2. Inspect the ledger:
    ```bash
    tail -1 test-harness/.orchestration/agent_trace.jsonl | python3 -m json.tool
    ```

**Expected output:**

```json
{
    "mutationClass": "AST_REFACTOR",
    "mutationType": "WRITE",
    "filePath": "src/auth/login.ts",
    "intentId": "refactor-auth",
    ...
}
```

**Verify:**

- ✅ `mutationClass` changed from `"INTENT_EVOLUTION"` to `"AST_REFACTOR"`
- ✅ `contentHash` differs from Test 15 (file changed)
- ✅ Both entries have different `id` values

```bash
# Compare hashes
cat test-harness/.orchestration/agent_trace.jsonl | python3 -c "
import sys, json
lines = [json.loads(l) for l in sys.stdin if l.strip()]
for e in lines:
    print(f'{e[\"mutationClass\"]:20} {e[\"contentHash\"][:16]}...')
"
```

---

### Test 17 ▸ Restart Safety — Classification Survives Reload

**What it proves:** After restarting the extension, classification reads the ledger (not in-memory cache) and still returns `AST_REFACTOR`.

**Steps:**

1. Complete Tests 15+16 (ledger has 2 entries for `login.ts`)
2. **Restart the Extension Dev Host** (press Ctrl+Shift+F5 or close and re-launch with F5)
3. Re-open `test-harness/` workspace
4. Select intent `refactor-auth`
5. Type: _"Add a JSDoc comment to login.ts"_
6. Inspect:
    ```bash
    tail -1 test-harness/.orchestration/agent_trace.jsonl | python3 -m json.tool
    ```

**Expected output:**

```json
{
    "mutationClass": "AST_REFACTOR",
    ...
}
```

- ✅ Still `"AST_REFACTOR"` — proves ledger was re-read after restart
- ✅ If this showed `"INTENT_EVOLUTION"`, classification is broken

---

### Test 18 ▸ New File → INTENT_EVOLUTION

**What it proves:** Writing to a file never touched by this intent is classified as `INTENT_EVOLUTION`.

**Steps:**

1. Type: _"Create a new file src/auth/middleware.ts with a basic auth middleware function"_
2. Inspect:
    ```bash
    tail -1 test-harness/.orchestration/agent_trace.jsonl | python3 -m json.tool
    ```

**Expected output:**

```json
{
    "mutationClass": "INTENT_EVOLUTION",
    "mutationType": "WRITE",
    "filePath": "src/auth/middleware.ts",
    "intentId": "refactor-auth",
    ...
}
```

- ✅ New file = `"INTENT_EVOLUTION"` (first touch by this intent)

---

### Test 19 ▸ Ledger Integrity — Content Hash Matches Disk

**What it proves:** `contentHash` is derived from the actual file on disk, not the LLM payload.

**Steps:**

1. After any successful write, verify the hash:

    ```bash
    # Get hash from ledger
    LEDGER_HASH=$(tail -1 test-harness/.orchestration/agent_trace.jsonl | python3 -c "import sys,json; print(json.loads(sys.stdin.read())['contentHash'])")

    # Compute hash from actual file
    DISK_HASH=$(shasum -a 256 test-harness/src/auth/login.ts | awk '{print $1}')

    echo "Ledger: $LEDGER_HASH"
    echo "Disk:   $DISK_HASH"

    # They should match
    [ "$LEDGER_HASH" = "$DISK_HASH" ] && echo "✅ MATCH" || echo "❌ MISMATCH"
    ```

- ✅ Hashes match — proves disk-truth, not payload-trust

---

### Test 20 ▸ Append-Only — Ledger Never Overwritten

**What it proves:** Each write appends a new line; previous entries are never modified.

**Steps:**

1. Count lines before:
    ```bash
    wc -l test-harness/.orchestration/agent_trace.jsonl
    ```
2. Ask the agent to make another edit
3. Count lines after:
    ```bash
    wc -l test-harness/.orchestration/agent_trace.jsonl
    ```

**Expected:**

- ✅ Line count increased by exactly 1
- ✅ Previous lines unchanged (use `diff` or `md5` to verify)

```bash
# Full integrity check — every line is valid JSON
python3 -c "
import json, sys
with open('test-harness/.orchestration/agent_trace.jsonl') as f:
    for i, line in enumerate(f, 1):
        if line.strip():
            try:
                json.loads(line)
                print(f'  Line {i}: ✅ valid')
            except:
                print(f'  Line {i}: ❌ MALFORMED')
"
```

---

### Test 21 ▸ Error Outcome Still Logged

**What it proves:** Even when a tool fails, a trace entry is recorded with `outcome: "error"`.

**Steps:**

1. Attempt to write to a write-protected file or trigger a tool error by writing to an invalid path
2. Check the ledger for the error entry:
    ```bash
    tail -1 test-harness/.orchestration/agent_trace.jsonl | python3 -m json.tool
    ```

**Expected:**

```json
{
    "outcome": "error",
    "error": "<error message>",
    "contentHash": null,
    ...
}
```

- ✅ `outcome` is `"error"` (not missing)
- ✅ `error` field present with message
- ✅ `contentHash` is `null` (can't hash non-existent file)

---

### Test 22 ▸ Non-Write Tools Don't Produce Entries

**What it proves:** Only write-class tools are traced. Read tools are silent.

**Steps:**

1. Count ledger lines:
    ```bash
    wc -l test-harness/.orchestration/agent_trace.jsonl
    ```
2. Type: _"Read the contents of src/shared/utils.ts"_
3. Count ledger lines again

**Expected:**

- ✅ Line count unchanged — `read_file` is not a write tool
- ✅ No entry with `"tool": "read_file"` in ledger

---

## Updated Summary Table

| #   | Test                         | Phase | Feature Tested           | Expected                 |
| --- | ---------------------------- | ----- | ------------------------ | ------------------------ |
| 1   | No intent + destructive tool | P1    | Gatekeeper               | ❌ Blocked               |
| 2   | Valid intent + in-scope edit | P1+P2 | Handshake + Scope + Auth | ✅ Executes              |
| 3   | PAUSED intent selection      | P1    | Intent validation        | ❌ Rejected              |
| 4   | YAML changed mid-session     | P1    | Live revalidation        | ❌ Stale cleared         |
| 5   | No `.orchestration/` folder  | P1    | Ungoverned mode          | ✅ Free execution        |
| 6   | Safe tool, no intent         | P1+P2 | SAFE classification      | ✅ Free execution        |
| 7   | `read_file(".env")`          | P2    | SENSITIVE classification | ⚠️ Auth dialog           |
| 8   | `read_file("*.pem")`         | P2    | SENSITIVE classification | ⚠️ Auth dialog           |
| 9   | In-scope write               | P2    | Scope enforcer           | ✅ Passes scope          |
| 10  | Out-of-scope write           | P2    | 3-button modal           | ⚠️ Reject/Once/Expand    |
| 11  | Path traversal (`../`)       | P2    | Path normalization       | ❌ Immediate block       |
| 12  | `.intentignore` file         | P2    | Scope exemption          | ✅ Bypasses scope        |
| 13  | Error payloads               | P2    | `suggestedFix` field     | ✅ Actionable guidance   |
| 14  | Approve/reject timing        | P2    | Promise blocking         | ⚠️ Blocks until click    |
| 15  | First write → ledger created | P3    | Auto-create JSONL        | ✅ Entry with all fields |
| 16  | Re-edit → AST_REFACTOR       | P3    | Mutation classification  | ✅ Class changes         |
| 17  | Restart → classification OK  | P3    | Restart safety           | ✅ Reads ledger          |
| 18  | New file → INTENT_EVOLUTION  | P3    | First-touch detection    | ✅ Correct class         |
| 19  | contentHash matches disk     | P3    | Disk-truth hashing       | ✅ SHA-256 match         |
| 20  | Append-only integrity        | P3    | Ledger immutability      | ✅ Line count +1         |
| 21  | Error outcome logged         | P3    | Failure tracing          | ✅ outcome: "error"      |
| 22  | Read tools not traced        | P3    | Write-only filter        | ✅ No entry added        |

---

## Troubleshooting

| Problem                                  | Solution                                                                                      |
| ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| Extension not loading                    | Press **F5** to relaunch dev host; check Output → "Roo Code"                                  |
| No governance errors                     | Verify `.orchestration/` exists in the **workspace root**                                     |
| Tests report wrong classification        | Run unit tests: `cd src && ./node_modules/.bin/vitest run hooks/__tests__/HookEngine.spec.ts` |
| `pending_scope_updates.json` not created | Ensure `.orchestration/` directory exists and is writable                                     |
| Authorization dialog not appearing       | Check that the tool is classified as DESTRUCTIVE or SENSITIVE, not SAFE                       |
| `agent_trace.jsonl` not created          | Ensure workspace is governed (`.orchestration/` exists) and intent is selected                |
| `contentHash` mismatch with disk         | File may have been modified after trace was written; re-run hash comparison                   |
| `mutationClass` always INTENT_EVOLUTION  | Check if `agent_trace.jsonl` is readable; classifier reads it on first call                   |
| Phase 3 tests failing                    | Run `cd src && ./node_modules/.bin/vitest run hooks/__tests__/phase3.spec.ts`                 |
