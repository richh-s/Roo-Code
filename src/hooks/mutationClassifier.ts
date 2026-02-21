/**
 * Phase 3 — Mutation Classifier (Ledger-Based, Restart-Safe)
 *
 * Classifies file mutations as AST_REFACTOR or INTENT_EVOLUTION
 * by reading prior writes from the agent_trace.jsonl ledger.
 *
 * Design invariants:
 * - Classification is derived from ledger state, never in-memory alone.
 * - On first call, reads the ledger and caches a Set<intentId::filePath>.
 * - Only entries with outcome==="success" AND mutationType==="WRITE" count.
 * - DELETE entries are excluded to prevent Delete→Recreate misclassification.
 * - After each new trace write, the cache is updated in-memory to stay in sync.
 * - Malformed JSONL lines are skipped silently (never crash on corruption).
 */

import fs from "fs/promises"
import path from "path"

import type { AgentTraceEntry, MutationClass } from "./traceSchema"
import { TRACE_LEDGER_PATH } from "./traceSchema"

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/**
 * Set of "intentId::filePath" keys from the ledger.
 * `null` means cache has not been initialized (first call will load).
 */
let priorWrites: Set<string> | null = null

/**
 * Build the cache key from intentId and filePath.
 * Both must already be canonicalized before calling this.
 */
function cacheKey(intentId: string, filePath: string): string {
	return `${intentId}::${filePath}`
}

// ---------------------------------------------------------------------------
// Ledger Parsing
// ---------------------------------------------------------------------------

/**
 * Read the ledger file and rebuild the prior-writes cache.
 * Called once on first classification request.
 *
 * - Reads line by line
 * - JSON.parse each line inside try/catch (skip malformed)
 * - Only counts entries with outcome==="success" AND mutationType==="WRITE"
 *
 * Performance: ~100–200ms for 50,000 lines. Acceptable at activation.
 */
async function buildCacheFromLedger(cwd: string): Promise<Set<string>> {
	const set = new Set<string>()
	const ledgerPath = path.join(cwd, TRACE_LEDGER_PATH)

	try {
		const content = await fs.readFile(ledgerPath, "utf8")
		const lines = content.split("\n")

		for (const line of lines) {
			const trimmed = line.trim()
			if (!trimmed) continue

			try {
				const entry = JSON.parse(trimmed) as Partial<AgentTraceEntry>

				// Only count successful WRITE entries for classification
				if (entry.outcome === "success" && entry.mutationType === "WRITE" && entry.intentId && entry.filePath) {
					set.add(cacheKey(entry.intentId, entry.filePath))
				}
			} catch {
				// Malformed JSONL line — skip silently, continue processing
				continue
			}
		}
	} catch (err: unknown) {
		// ENOENT (no ledger yet) is expected on first run.
		// Any other error: log but don't crash.
		if (err instanceof Error && (err as NodeJS.ErrnoException).code !== "ENOENT") {
			console.warn("[MutationClassifier] Failed to read ledger:", err.message)
		}
	}

	return set
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify a file mutation as AST_REFACTOR or INTENT_EVOLUTION.
 *
 * - `AST_REFACTOR`:      Ledger has a prior successful WRITE by this intentId
 *                         to this filePath.
 * - `INTENT_EVOLUTION`:  No prior successful WRITE by this intentId to this
 *                         filePath in the ledger.
 *
 * On first call, reads `.orchestration/agent_trace.jsonl` to build the cache.
 * Subsequent calls use the cached set (updated after each trace write).
 *
 * @param cwd       - Workspace root directory
 * @param intentId  - Active intent ID
 * @param filePath  - Canonical relative POSIX path (pre-normalized)
 * @returns Mutation classification
 */
export async function classifyMutation(cwd: string, intentId: string, filePath: string): Promise<MutationClass> {
	// Lazy initialization: build cache from ledger on first call
	if (priorWrites === null) {
		priorWrites = await buildCacheFromLedger(cwd)
	}

	const key = cacheKey(intentId, filePath)
	return priorWrites.has(key) ? "AST_REFACTOR" : "INTENT_EVOLUTION"
}

/**
 * Record a successful write in the in-memory cache.
 * Called after appending a trace entry to keep the cache in sync
 * without re-reading the ledger.
 *
 * @param intentId - Active intent ID
 * @param filePath - Canonical relative POSIX path
 */
export function recordWrite(intentId: string, filePath: string): void {
	if (priorWrites === null) {
		// Cache not initialized yet — will be built on next classifyMutation call
		return
	}
	priorWrites.add(cacheKey(intentId, filePath))
}

/**
 * Reset the classifier cache. Forces a full re-read from ledger on next call.
 * Primarily used for testing.
 */
export function resetClassifierCache(): void {
	priorWrites = null
}
