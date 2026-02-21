/**
 * Phase 2 — Hook Middleware Public API
 *
 * Barrel export for the Hook Engine and its components.
 */

// Core engine
export { HookEngine, hookEngine, buildHookContext } from "./HookEngine"

// Types
export type { HookContext, HookResult, ScopeCheckResult, ToolClassification, PreHookFn, PostHookFn } from "./types"

// Command classification
export { classifyTool, classifyWithPath, isSensitivePath, isExplicitlyDestructive } from "./commandClassifier"

// Authorization
export { authorizationHook } from "./authorizationHook"

export {
	scopeEnforcerHook,
	isPathInScope,
	extractTargetPath,
	checkScopeViolation,
	normaliseAndValidatePath,
} from "./scopeEnforcer"

// Intent ignore
export { loadIntentIgnorePatterns, parseIntentIgnore, isIgnoredByIntent, INTENT_IGNORE_PATH } from "./intentIgnore"

// Tool error builder
export {
	buildToolError,
	buildScopeViolationError,
	buildAuthorizationRejectedError,
	buildPathTraversalError,
	buildSensitiveReadError,
	HookErrorCode,
} from "./toolError"
export type { HookErrorCodeValue } from "./toolError"

// Pending scope updates
export { writePendingScopeUpdate, loadPendingScopeUpdates } from "./pendingScopeUpdates"
export type { PendingScopeUpdate } from "./pendingScopeUpdates"

// Phase 3 — Trace Ledger
export type { AgentTraceEntry, MutationClass, MutationType } from "./traceSchema"
export { WRITE_TOOLS, DELETE_TOOLS, TRACE_LEDGER_PATH } from "./traceSchema"
export { canonicalizePath } from "./pathNormalize"
export { sha256 } from "./contentHash"
export { classifyMutation, recordWrite, resetClassifierCache } from "./mutationClassifier"
export { traceSerializerHook, resetTraceSerializerState } from "./traceSerializerHook"

// Phase 4 — Optimistic Locking & Lesson Recording
export { recordRead, getReadHash, clearRead, clearAllReads } from "./readHashTracker"
export { staleLockHook } from "./staleLockHook"
export { lessonRecorderHook, resetLessonDedup } from "./lessonRecorderHook"
