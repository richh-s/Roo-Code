/**
 * Phase 2 — Pending Scope Updates
 *
 * When a user approves a scope expansion during a scope violation dialog,
 * the expansion request is written to `.orchestration/pending_scope_updates.json`.
 *
 * This preserves the trust boundary: the YAML is never auto-edited.
 * A human or CI process can review and apply pending expansions.
 */

import * as fs from "fs"
import * as path from "path"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PendingScopeUpdate {
	intentId: string
	newPattern: string
	filePath: string
	timestamp: string
	approvedBy: "user"
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PENDING_FILE = ".orchestration/pending_scope_updates.json"

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record a pending scope expansion request.
 *
 * Appends to the existing pending_scope_updates.json array, or creates
 * a new file if none exists.
 *
 * @param cwd       - Workspace root
 * @param intentId  - Intent requesting scope expansion
 * @param filePath  - The file that triggered the scope violation
 */
export function writePendingScopeUpdate(cwd: string, intentId: string, filePath: string): void {
	const fullPath = path.join(cwd, PENDING_FILE)

	// Derive a pattern from the file path (directory-level expansion)
	const dirName = path.posix.dirname(filePath)
	const newPattern = dirName === "." ? filePath : `${dirName}/*`

	const update: PendingScopeUpdate = {
		intentId,
		newPattern,
		filePath,
		timestamp: new Date().toISOString(),
		approvedBy: "user",
	}

	let existing: PendingScopeUpdate[] = []
	try {
		if (fs.existsSync(fullPath)) {
			const raw = fs.readFileSync(fullPath, "utf-8")
			existing = JSON.parse(raw)
		}
	} catch {
		// File corrupt or missing — start fresh
		existing = []
	}

	existing.push(update)

	// Ensure .orchestration directory exists
	const dir = path.dirname(fullPath)
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true })
	}

	fs.writeFileSync(fullPath, JSON.stringify(existing, null, 2) + "\n", "utf-8")
}

/**
 * Load pending scope updates for a given intent.
 */
export function loadPendingScopeUpdates(cwd: string, intentId?: string): PendingScopeUpdate[] {
	const fullPath = path.join(cwd, PENDING_FILE)
	try {
		if (!fs.existsSync(fullPath)) {
			return []
		}
		const raw = fs.readFileSync(fullPath, "utf-8")
		const all: PendingScopeUpdate[] = JSON.parse(raw)
		if (intentId) {
			return all.filter((u) => u.intentId === intentId)
		}
		return all
	} catch {
		return []
	}
}
