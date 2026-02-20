/**
 * Phase 2 — Command Classification
 *
 * Requirement 1: Classify commands as SAFE (read-only), SENSITIVE (reads
 * secrets/config), or DESTRUCTIVE (write, delete, execute).
 *
 * SAFE tools bypass all enforcement.
 * SENSITIVE tools require authorization but skip scope enforcement.
 * DESTRUCTIVE tools are subject to scope enforcement + authorization.
 */

import type { ToolClassification } from "./types"

// ---------------------------------------------------------------------------
// Safe tool set — tools that never mutate the workspace
// ---------------------------------------------------------------------------

/**
 * Tools classified as SAFE (read-only / non-destructive).
 * These bypass all hook enforcement in governed mode.
 *
 * NOTE: `read_file` is safe by default but may be promoted to SENSITIVE
 * based on the target file path (see `classifyWithPath`).
 */
const SAFE_TOOL_SET: ReadonlySet<string> = new Set([
	// ── Read-only tools ──
	"read_file",
	"search_files",
	"list_files",
	"codebase_search",
	"read_command_output",

	// ── Non-destructive / meta tools ──
	"ask_followup_question",
	"attempt_completion",
	"switch_mode",
	"new_task",
	"update_todo_list",
	"run_slash_command",
	"skill",

	// ── Intent tool itself ──
	"select_active_intent",
])

// ---------------------------------------------------------------------------
// Destructive tool set — tools that mutate files or execute commands
// ---------------------------------------------------------------------------

/**
 * Tools explicitly classified as DESTRUCTIVE.
 * Any tool NOT in SAFE_TOOL_SET is treated as destructive, but this
 * explicit list is kept for documentation and quick lookup.
 */
const DESTRUCTIVE_TOOL_SET: ReadonlySet<string> = new Set([
	"write_to_file",
	"apply_diff",
	"edit",
	"search_and_replace",
	"search_replace",
	"edit_file",
	"apply_patch",
	"execute_command",
	"use_mcp_tool",
	"access_mcp_resource",
	"generate_image",
])

// ---------------------------------------------------------------------------
// Sensitive file patterns — reads that expose secrets or config
// ---------------------------------------------------------------------------

/**
 * File path patterns that indicate sensitive content.
 * When a read-only tool targets one of these, it is classified as
 * SENSITIVE (requires user approval even though it's read-only).
 *
 * Pattern types:
 * - Exact basename: `.env`, `.npmrc`, `id_rsa`
 * - Extension:      `.pem`, `.key`
 * - Prefix:         `secrets.`, `.orchestration/`
 */
const SENSITIVE_PATTERNS = {
	/** Exact filenames (basename match) */
	exactNames: new Set([
		".env",
		".env.local",
		".env.production",
		".env.development",
		".env.staging",
		".npmrc",
		".netrc",
		"id_rsa",
		"id_ed25519",
		"id_dsa",
		".htpasswd",
		".pgpass",
	]),

	/** File extensions (without dot) */
	extensions: new Set(["pem", "key", "p12", "pfx", "jks", "keystore"]),

	/** Path prefixes or directory names */
	pathPrefixes: [".orchestration/"],

	/** Basename prefixes (e.g. secrets.yaml, secrets.json) */
	basenamePrefixes: ["secrets.", "credentials.", "secret_", "credential_"],
} as const

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify a tool as SAFE or DESTRUCTIVE (name-only, no path awareness).
 *
 * @param toolName - The tool name string from the LLM's tool_use block.
 * @returns `"safe"` if the tool is read-only, `"destructive"` otherwise.
 */
export function classifyTool(toolName: string): ToolClassification {
	if (SAFE_TOOL_SET.has(toolName)) {
		return "safe"
	}
	return "destructive"
}

/**
 * Classify a tool with path-aware sensitivity detection.
 *
 * For safe tools that target a file path, this checks whether the path
 * matches a sensitive pattern. If so, the tool is promoted from "safe"
 * to "sensitive" (requires authorization but skips scope enforcement).
 *
 * @param toolName - The tool name string
 * @param params   - Tool parameters (may contain path/file_path)
 * @returns `"safe"`, `"sensitive"`, or `"destructive"`
 */
export function classifyWithPath(toolName: string, params: Record<string, unknown>): ToolClassification {
	// Destructive tools stay destructive regardless of path
	if (!SAFE_TOOL_SET.has(toolName)) {
		return "destructive"
	}

	// Only check sensitivity for tools that access file paths
	const filePath = extractFilePathParam(params)
	if (filePath && isSensitivePath(filePath)) {
		return "sensitive"
	}

	return "safe"
}

/**
 * Check whether a file path matches any sensitive pattern.
 */
export function isSensitivePath(filePath: string): boolean {
	const normalised = filePath.replace(/\\/g, "/")
	const basename = normalised.split("/").pop() ?? ""
	const ext = basename.includes(".") ? (basename.split(".").pop() ?? "") : ""

	// Exact basename match
	if (SENSITIVE_PATTERNS.exactNames.has(basename)) {
		return true
	}

	// Extension match
	if (ext && SENSITIVE_PATTERNS.extensions.has(ext)) {
		return true
	}

	// Path prefix match (e.g. .orchestration/)
	for (const prefix of SENSITIVE_PATTERNS.pathPrefixes) {
		if (normalised.startsWith(prefix) || normalised.includes("/" + prefix)) {
			return true
		}
	}

	// Basename prefix match (e.g. secrets.yaml)
	for (const bp of SENSITIVE_PATTERNS.basenamePrefixes) {
		if (basename.startsWith(bp)) {
			return true
		}
	}

	return false
}

/**
 * Check whether a tool is in the explicit destructive set.
 * Useful for logging / telemetry.
 */
export function isExplicitlyDestructive(toolName: string): boolean {
	return DESTRUCTIVE_TOOL_SET.has(toolName)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PATH_KEYS = ["path", "file_path", "filePath", "filename"] as const

function extractFilePathParam(params: Record<string, unknown>): string | undefined {
	for (const key of PATH_KEYS) {
		const value = params[key]
		if (typeof value === "string" && value.length > 0) {
			return value
		}
	}
	return undefined
}
