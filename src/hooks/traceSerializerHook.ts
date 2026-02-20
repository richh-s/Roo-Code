/**
 * Phase 3 — Trace Serializer Post-Hook
 *
 * A PostHookFn that fires after write-class tools execute.
 * Produces an AgentTraceEntry and appends it to agent_trace.jsonl.
 *
 * Design invariants:
 * - Hash DISK content (fs.readFile), never ctx.params.content.
 * - Classify mutations SERVER-SIDE from ledger, never trust LLM.
 * - Detect DELETE by toolName, never by ENOENT alone.
 * - Serialize JSONL appends via async queue (prevent interleaving).
 * - Cache revisionId per session (one git call, reused).
 * - Auto-create .orchestration/ and agent_trace.jsonl (append-only).
 * - Never crash — all errors logged, not propagated.
 */

import { randomUUID } from "crypto"
import { execFile } from "child_process"
import fs from "fs/promises"
import path from "path"
import { promisify } from "util"

import type { PostHookFn } from "./types"
import type { AgentTraceEntry } from "./traceSchema"
import { WRITE_TOOLS, DELETE_TOOLS, TRACE_LEDGER_PATH } from "./traceSchema"
import { sha256 } from "./contentHash"
import { canonicalizePath } from "./pathNormalize"
import { classifyMutation, recordWrite } from "./mutationClassifier"

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// VCS Revision Cache (per session)
// ---------------------------------------------------------------------------

/**
 * Cached git HEAD revision. Computed once on first trace write,
 * reused for all subsequent entries in the session.
 */
let cachedRevisionId: string | undefined
let revisionFetched = false

/**
 * Get the current git HEAD revision, cached per session.
 * Returns undefined if not a git repository or git is unavailable.
 */
async function getRevisionId(cwd: string): Promise<string | undefined> {
	if (revisionFetched) return cachedRevisionId

	revisionFetched = true
	try {
		const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
			cwd,
			timeout: 5000,
		})
		cachedRevisionId = stdout.trim() || undefined
	} catch {
		// Not a git repo or git not available — graceful
		cachedRevisionId = undefined
	}

	return cachedRevisionId
}

// ---------------------------------------------------------------------------
// Async Write Queue (Concurrency-Safe)
// ---------------------------------------------------------------------------

/**
 * Serialized promise chain prevents interleaved writes to the JSONL ledger.
 * Each append waits for the previous one to complete.
 */
let writeChain = Promise.resolve()

function enqueueAppend(cwd: string, entry: AgentTraceEntry): void {
	writeChain = writeChain
		.then(() => appendTraceEntry(cwd, entry))
		.catch((err) => console.warn("[TraceSerializer] Write failed:", err))
}

/**
 * Append a single trace entry to the ledger file.
 * Auto-creates directory and file if missing. Never overwrites.
 */
async function appendTraceEntry(cwd: string, entry: AgentTraceEntry): Promise<void> {
	const dir = path.join(cwd, ".orchestration")
	await fs.mkdir(dir, { recursive: true })
	const ledgerFile = path.join(cwd, TRACE_LEDGER_PATH)
	await fs.appendFile(ledgerFile, JSON.stringify(entry) + "\n", "utf8")
}

// ---------------------------------------------------------------------------
// File Path Extraction
// ---------------------------------------------------------------------------

/**
 * Extract the file path from tool parameters.
 * Different write tools use different parameter names.
 */
function extractFilePath(toolName: string, params: Record<string, unknown>): string | undefined {
	// Most write tools use 'path'
	if (typeof params.path === "string" && params.path) {
		return params.path
	}

	// apply_diff / apply_patch may use 'file_path'
	if (typeof params.file_path === "string" && params.file_path) {
		return params.file_path
	}

	// apply_patch embeds path in patch content — extract from "*** Update File: ..."
	// Markers: "*** Add File: ", "*** Update File: ", "*** Delete File: "
	if (toolName === "apply_patch" && typeof params.patch === "string") {
		const match = params.patch.match(/\*{3}\s+(?:Update|Add|Delete)\s+File:\s+(.+?)$/m)
		if (match?.[1]) {
			return match[1].trim()
		}
	}

	return undefined
}

// ---------------------------------------------------------------------------
// Trace Serializer Hook
// ---------------------------------------------------------------------------

/**
 * Post-hook that fires after tool execution to produce trace entries.
 *
 * Pipeline:
 * 1. Filter: only write/delete tools
 * 2. Extract and canonicalize file path
 * 3. Read disk content → sha256 (or null on ENOENT)
 * 4. Classify mutation from ledger (server-side only)
 * 5. Get revisionId (cached per session)
 * 6. Build AgentTraceEntry with UUID
 * 7. Enqueue to async write queue
 * 8. Update classifier cache
 */
export const traceSerializerHook: PostHookFn = async (ctx, outcome) => {
	const isWriteTool = WRITE_TOOLS.has(ctx.toolName)
	const isDeleteTool = DELETE_TOOLS.has(ctx.toolName)

	// Only trace write-class and delete-class tools
	if (!isWriteTool && !isDeleteTool) return

	// Must have an active intent for tracing
	if (!ctx.activeIntentId) return

	// Extract file path from tool parameters
	const rawPath = extractFilePath(ctx.toolName, ctx.params)
	if (!rawPath) return

	try {
		// Canonicalize path for deterministic keys
		const filePath = canonicalizePath(rawPath, ctx.cwd)
		const resolvedPath = path.resolve(ctx.cwd, filePath)

		// Determine mutation type by toolName (not ENOENT)
		const mutationType = isDeleteTool ? ("DELETE" as const) : ("WRITE" as const)

		// Hash disk content (reality, not payload)
		let contentHash: string | null = null
		let fileSizeBytes: number | undefined

		if (outcome.success || !isDeleteTool) {
			try {
				const finalContent = await fs.readFile(resolvedPath, "utf8")
				contentHash = sha256(finalContent)
				const stats = await fs.stat(resolvedPath)
				fileSizeBytes = stats.size
			} catch (readErr: unknown) {
				// ENOENT expected for deletions or failed writes
				// contentHash stays null, fileSizeBytes stays undefined
				if (readErr instanceof Error && (readErr as NodeJS.ErrnoException).code !== "ENOENT") {
					console.warn("[TraceSerializer] Unexpected read error:", readErr)
				}
			}
		}

		// Classify mutation from ledger (server-side, never trust LLM)
		const mutationClass = await classifyMutation(ctx.cwd, ctx.activeIntentId, filePath)

		// Get git revision (cached per session)
		const revisionId = await getRevisionId(ctx.cwd)

		// Build trace entry
		const entry: AgentTraceEntry = {
			id: randomUUID(),
			timestamp: new Date().toISOString(),
			tool: ctx.toolName,
			intentId: ctx.activeIntentId,
			mutationClass,
			mutationType,
			filePath,
			contentHash,
			outcome: outcome.success ? "success" : "error",
			error: outcome.error,
			revisionId,
			fileSizeBytes,
			toolArgsSnapshot: { path: rawPath },
		}

		// Enqueue to serialized write queue
		enqueueAppend(ctx.cwd, entry)

		// Update classifier cache (keep in sync without re-reading ledger)
		if (outcome.success && mutationType === "WRITE") {
			recordWrite(ctx.activeIntentId, filePath)

			// Phase 4: Clear stale-lock hash after full write success.
			// Runs here (post-hook) NOT in staleLockHook (pre-hook) so
			// the hash persists if later pre-hooks block the write.
			const { clearRead } = await import("./readHashTracker")
			clearRead(ctx.cwd, filePath)
		}
	} catch (err) {
		// Post-hooks are fire-and-forget — never crash
		console.warn("[TraceSerializer] Hook error (non-fatal):", err)
	}
}

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

/**
 * Reset all cached state. Used for testing only.
 */
export function resetTraceSerializerState(): void {
	cachedRevisionId = undefined
	revisionFetched = false
	writeChain = Promise.resolve()
}
