/**
 * Phase 2 — Scope Enforcer (Pre-Hook)
 *
 * Requirement 4: In the write_file Pre-Hook, check if the target file
 * matches the owned_scope of the active intent.
 *
 * Security hardening:
 * - Path traversal prevention: normalise with path.resolve(), reject if
 *   resolved path is outside the workspace root.
 * - Scope matching uses simple prefix / wildcard matching.
 * - .intentignore exemptions supported.
 */

import * as vscode from "vscode"
import * as path from "path"
import type { HookContext, HookResult, ScopeCheckResult } from "./types"
import { buildScopeViolationError, buildPathTraversalError } from "./toolError"
import { loadIntentIgnorePatterns, isIgnoredByIntent } from "./intentIgnore"
import { loadActiveIntents, findIntentById } from "../core/context/activeIntents"
import { writePendingScopeUpdate } from "./pendingScopeUpdates"

// ---------------------------------------------------------------------------
// Tools that carry a target file path
// ---------------------------------------------------------------------------

const PATH_PARAM_KEYS = ["path", "file_path", "filePath", "filename"] as const

// ---------------------------------------------------------------------------
// Path Security
// ---------------------------------------------------------------------------

/**
 * Normalise a file path and check it is within the workspace.
 *
 * Returns the workspace-relative POSIX path if safe, or `null` if the
 * path resolves outside the workspace (path traversal attempt).
 *
 * @param targetPath - Raw path from tool params (may be absolute or relative)
 * @param cwd        - Workspace root directory (absolute)
 */
export function normaliseAndValidatePath(
	targetPath: string,
	cwd: string,
): { relativePath: string } | { traversal: true } {
	const resolved = path.resolve(cwd, targetPath)
	const normalisedCwd = cwd.endsWith(path.sep) ? cwd : cwd + path.sep

	// Check that resolved path is within workspace root
	if (!resolved.startsWith(normalisedCwd) && resolved !== cwd.replace(/\/$/, "")) {
		return { traversal: true }
	}

	// Convert to workspace-relative POSIX path
	const relativePath = path.relative(cwd, resolved).replace(/\\/g, "/")
	return { relativePath }
}

// ---------------------------------------------------------------------------
// Scope Matching
// ---------------------------------------------------------------------------

/**
 * Check whether a relative file path is within any of the intent's scope globs.
 *
 * Matching rules (simple, no external glob library):
 * - `src/auth/*`   → matches any file directly in `src/auth/`
 * - `src/auth/**`  → matches any file at any depth under `src/auth/`
 * - `src/**`       → matches everything under `src/`
 * - Exact match    → `src/auth/login.ts` matches `src/auth/login.ts`
 */
export function isPathInScope(filePath: string, scopeGlobs: string[]): boolean {
	if (scopeGlobs.length === 0) {
		return true
	}

	const normalised = filePath.replace(/\\/g, "/")

	for (const glob of scopeGlobs) {
		const g = glob.replace(/\\/g, "/")

		// Exact match
		if (normalised === g) {
			return true
		}

		// "dir/**" → recursive wildcard
		if (g.endsWith("/**")) {
			const prefix = g.slice(0, -3)
			if (normalised.startsWith(prefix + "/") || normalised === prefix) {
				return true
			}
		}

		// "dir/*" → single-level wildcard
		if (g.endsWith("/*") && !g.endsWith("/**")) {
			const prefix = g.slice(0, -2)
			if (normalised.startsWith(prefix + "/")) {
				const rest = normalised.slice(prefix.length + 1)
				if (!rest.includes("/")) {
					return true
				}
			}
		}

		// Plain directory prefix (e.g. "src/auth" without wildcard)
		if (!g.includes("*") && normalised.startsWith(g + "/")) {
			return true
		}
	}

	return false
}

// ---------------------------------------------------------------------------
// Pre-Hook: Scope Enforcement
// ---------------------------------------------------------------------------

/**
 * Extract the target file path from tool parameters.
 */
export function extractTargetPath(params: Record<string, unknown>): string | undefined {
	for (const key of PATH_PARAM_KEYS) {
		const value = params[key]
		if (typeof value === "string" && value.length > 0) {
			return value
		}
	}
	return undefined
}

/**
 * Scope enforcement pre-hook.
 *
 * Security checks in order:
 *   1. Path traversal prevention (resolve + workspace boundary check)
 *   2. .intentignore exemptions
 *   3. Scope glob matching
 */
export async function scopeEnforcerHook(ctx: HookContext): Promise<HookResult> {
	if (!ctx.activeIntentId) {
		return { proceed: true }
	}

	// Dynamically load scope from YAML if not already in context
	let scope = ctx.activeIntentScope
	if (!scope) {
		try {
			const intents = await loadActiveIntents(ctx.cwd)
			const intent = findIntentById(intents, ctx.activeIntentId)
			if (intent) {
				scope = intent.scope
				ctx.activeIntentScope = scope
			}
		} catch {
			return { proceed: true }
		}
	}

	if (!scope || scope.length === 0) {
		return { proceed: true }
	}

	// Extract target path from tool params
	const targetPath = extractTargetPath(ctx.params)
	if (!targetPath) {
		return { proceed: true }
	}

	// ── Security: Path traversal prevention ──
	const pathResult = normaliseAndValidatePath(targetPath, ctx.cwd)
	if ("traversal" in pathResult) {
		const errorPayload = buildPathTraversalError(targetPath, ctx.cwd)
		return {
			proceed: false,
			error: errorPayload,
			reason: `Path Traversal Blocked: "${targetPath}" resolves outside workspace`,
		}
	}

	const relativePath = pathResult.relativePath

	// Check .intentignore — exempted files bypass scope enforcement
	const ignorePatterns = loadIntentIgnorePatterns(ctx.cwd)
	if (isIgnoredByIntent(relativePath, ignorePatterns)) {
		return { proceed: true }
	}

	// Check scope
	if (!isPathInScope(relativePath, scope)) {
		// Show 3-button modal for scope violation workflow
		const intentLabel = ctx.activeIntentId ?? "unknown"
		const scopeDisplay = scope.join(", ")
		const message =
			`[Scope Violation] Intent "${intentLabel}" attempted to edit "${relativePath}".\n\n` +
			`Allowed scope: [${scopeDisplay}]\n\n` +
			`How would you like to proceed?`

		const choice = await vscode.window.showWarningMessage(
			message,
			{ modal: true },
			"Reject",
			"Approve Once",
			"Approve & Expand Scope",
		)

		if (choice === "Approve Once") {
			// One-time bypass — not persisted, will block again next time
			return { proceed: true, reason: `User approved one-time bypass for ${relativePath}` }
		}

		if (choice === "Approve & Expand Scope") {
			// Persist the expansion request (does NOT auto-edit YAML)
			writePendingScopeUpdate(ctx.cwd, ctx.activeIntentId!, relativePath)
			return {
				proceed: true,
				reason: `User approved and proposed scope expansion for ${relativePath}`,
			}
		}

		// Rejected or dismissed
		const errorPayload = buildScopeViolationError(ctx.activeIntentId!, relativePath, scope)
		return {
			proceed: false,
			error: errorPayload,
			reason: `Scope Violation: ${ctx.activeIntentId} is not authorized to edit ${relativePath}`,
		}
	}

	return { proceed: true }
}

/**
 * Check scope directly (utility for testing / external callers).
 */
export function checkScopeViolation(filePath: string, intentId: string, scopeGlobs: string[]): ScopeCheckResult {
	if (isPathInScope(filePath, scopeGlobs)) {
		return { allowed: true }
	}
	return {
		allowed: false,
		violation: `Scope Violation: ${intentId} is not authorized to edit ${filePath}. Request scope expansion.`,
	}
}
