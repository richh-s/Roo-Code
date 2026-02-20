/**
 * Phase 2 — Standardised Tool-Error Builder (Autonomous Recovery)
 *
 * Requirement 3: When a destructive action is rejected/blocked, return a
 * standardised JSON tool-error payload that the LLM can parse and use to
 * self-correct without crashing.
 *
 * Shape:
 * ```json
 * {
 *   "status": "error",
 *   "message": "<human readable>",
 *   "error": {
 *     "code": "<SHORT_CODE>",
 *     "details": { ... },
 *     "suggestedFix": "<actionable guidance for the LLM>"
 *   }
 * }
 * ```
 */

// ---------------------------------------------------------------------------
// Error Codes
// ---------------------------------------------------------------------------

/** Well-known error codes returned in the `error.code` field. */
export const HookErrorCode = {
	/** User rejected the tool call via the authorization dialog */
	AUTHORIZATION_REJECTED: "AUTHORIZATION_REJECTED",

	/** Tool target is outside the active intent's owned_scope */
	SCOPE_VIOLATION: "SCOPE_VIOLATION",

	/** Tool attempted path traversal outside the workspace */
	PATH_TRAVERSAL: "PATH_TRAVERSAL",

	/** Sensitive read blocked (e.g. .env, .pem) */
	SENSITIVE_READ_BLOCKED: "SENSITIVE_READ_BLOCKED",

	/** No active intent selected but a governed workspace requires one */
	NO_ACTIVE_INTENT: "NO_ACTIVE_INTENT",

	/** Generic hook rejection */
	HOOK_BLOCKED: "HOOK_BLOCKED",
} as const

export type HookErrorCodeValue = (typeof HookErrorCode)[keyof typeof HookErrorCode]

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Build a standardised JSON tool-error string.
 *
 * @param code         - Short error code (e.g. "SCOPE_VIOLATION")
 * @param message      - Human-readable description
 * @param details      - Optional extra context (file paths, intent IDs, etc.)
 * @param suggestedFix - Optional actionable guidance for the LLM to self-correct
 * @returns JSON string
 */
export function buildToolError(
	code: HookErrorCodeValue,
	message: string,
	details?: Record<string, unknown>,
	suggestedFix?: string,
): string {
	const payload = {
		status: "error" as const,
		message,
		error: {
			code,
			...(details ? { details } : {}),
			...(suggestedFix ? { suggestedFix } : {}),
		},
	}
	return JSON.stringify(payload)
}

/**
 * Build a scope-violation error.
 *
 * @param intentId   - Active intent ID
 * @param filePath   - The file the tool tried to modify
 * @param ownedScope - The intent's allowed scope globs
 */
export function buildScopeViolationError(intentId: string, filePath: string, ownedScope: string[]): string {
	const message =
		`Scope Violation: ${intentId} is not authorized to edit ${filePath}. ` +
		`Allowed scope: [${ownedScope.join(", ")}].`

	return buildToolError(
		HookErrorCode.SCOPE_VIOLATION,
		message,
		{
			intentId,
			filePath,
			allowedScope: ownedScope,
			requestedPath: filePath,
		},
		"Ask the user to expand the scope or select a different intent that owns this file.",
	)
}

/**
 * Build an authorization-rejected error.
 *
 * @param toolName - The tool that was rejected
 * @param intentId - The active intent context (if any)
 */
export function buildAuthorizationRejectedError(toolName: string, intentId?: string): string {
	const message =
		`Authorization rejected: user declined execution of "${toolName}". ` + `The user did not approve this action.`

	return buildToolError(
		HookErrorCode.AUTHORIZATION_REJECTED,
		message,
		{
			toolName,
			...(intentId ? { intentId } : {}),
		},
		"Try a different approach, explain your reasoning to the user, or ask for guidance.",
	)
}

/**
 * Build a path-traversal error.
 *
 * @param filePath - The path that attempted traversal
 * @param cwd      - The workspace root
 */
export function buildPathTraversalError(filePath: string, cwd: string): string {
	const message =
		`Path Traversal Blocked: "${filePath}" resolves outside the workspace root. ` +
		`All file operations must stay within ${cwd}.`

	return buildToolError(
		HookErrorCode.PATH_TRAVERSAL,
		message,
		{
			requestedPath: filePath,
			workspaceRoot: cwd,
		},
		"Use a workspace-relative path instead of absolute or parent-traversal paths (e.g. '../').",
	)
}

/**
 * Build a sensitive-read error.
 *
 * @param toolName - The tool that was rejected
 * @param filePath - The sensitive file path
 */
export function buildSensitiveReadError(toolName: string, filePath: string): string {
	const message =
		`Sensitive Read Blocked: user declined reading "${filePath}". ` +
		`This file contains secrets or sensitive configuration.`

	return buildToolError(
		HookErrorCode.SENSITIVE_READ_BLOCKED,
		message,
		{
			toolName,
			filePath,
		},
		"Do not attempt to read secret files. Ask the user for the specific values you need instead.",
	)
}
