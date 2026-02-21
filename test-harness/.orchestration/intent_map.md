# Intent Map

> Auto-maintained by the orchestration layer.
> Each intent below maps to a defined scope and current status.

## Active Intents

### INT-001: `refactor-auth`

- **Goal:** Refactor authentication module for improved maintainability
- **Status:** IN_PROGRESS
- **Scope:** `src/auth/*`
- **Constraints:**
    - Do not modify public API
    - Preserve existing function signatures

---

### INT-002: `optimize-billing`

- **Goal:** Improve invoice generation performance
- **Status:** PAUSED
- **Scope:** `src/billing/*`
- **Constraints:**
    - No schema changes

---

## Agent Trace Summary

| File                  | Last Tool     | Classification   | Intent        |
| --------------------- | ------------- | ---------------- | ------------- |
| `src/auth/login.ts`   | `apply_patch` | AST_REFACTOR     | refactor-auth |
| `src/auth/session.ts` | `apply_patch` | INTENT_EVOLUTION | refactor-auth |
