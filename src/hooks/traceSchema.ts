/**
 * Phase 3 — Agent Trace Schema
 *
 * Types for the semantic tracking ledger. Every write produces a trace
 * entry appended to `.orchestration/agent_trace.jsonl`.
 */

// ---------------------------------------------------------------------------
// Mutation Classification
// ---------------------------------------------------------------------------

/**
 * Semantic classification of a file mutation.
 *
 * - `AST_REFACTOR`      — structural change to an existing file under the
 *                          same intent (rename, extract, move). Ledger already
 *                          contains a successful WRITE by this intent to this path.
 * - `INTENT_EVOLUTION`  — new feature or first-time touch. Either a new file or
 *                          the first write by this intent to this path.
 */
export type MutationClass = "AST_REFACTOR" | "INTENT_EVOLUTION"

/**
 * Type of file mutation.
 *
 * - `WRITE`  — file created or modified
 * - `DELETE` — file removed (detected by toolName, never by ENOENT alone)
 */
export type MutationType = "WRITE" | "DELETE"

// ---------------------------------------------------------------------------
// Trace Entry
// ---------------------------------------------------------------------------

/**
 * A single trace entry appended to `agent_trace.jsonl`.
 *
 * Design invariants:
 * - `contentHash` is from **disk content after write**, never tool payload.
 * - `mutationClass` is always **server-computed**, never from LLM.
 * - `filePath` is always **canonicalized** (relative, POSIX, no ./  ../).
 */
export interface AgentTraceEntry {
	/** UUIDv4 — prevents duplication ambiguity */
	id: string

	/** ISO-8601 timestamp */
	timestamp: string

	/** Tool that performed the mutation */
	tool: string

	/** Phase 1 intent ID (REQ-ID injection) */
	intentId: string

	/** Semantic classification — always server-computed from ledger state */
	mutationClass: MutationClass

	/** WRITE for creates/edits, DELETE for removals */
	mutationType: MutationType

	/** Canonical relative POSIX path (normalized via canonicalizePath) */
	filePath: string

	/**
	 * SHA-256 hex digest of actual disk content AFTER write.
	 * `null` for deletions or when file doesn't exist after a failed write.
	 */
	contentHash: string | null

	/** Execution outcome */
	outcome: "success" | "error"

	/** Error message (present only when outcome === "error") */
	error?: string

	/** Git HEAD revision at time of write (cached per session) */
	revisionId?: string

	/** File size in bytes after write (forensic debugging) */
	fileSizeBytes?: number

	/** Safe subset of tool args — path only, never content (privacy) */
	toolArgsSnapshot?: { path: string }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Tools that produce file mutations and should be traced */
export const WRITE_TOOLS = new Set([
	"write_to_file",
	"apply_diff",
	"apply_patch",
	"search_replace",
	"edit",
	"edit_file",
])

/** Tools that perform file deletion (detected by toolName, not ENOENT) */
export const DELETE_TOOLS = new Set(["delete_file"])

/** Path to the trace ledger file (relative to workspace root) */
export const TRACE_LEDGER_PATH = ".orchestration/agent_trace.jsonl"
