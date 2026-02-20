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
