/**
 * Phase 3 — Spatial Hashing
 *
 * SHA-256 hashing utility for content integrity verification.
 * Pure function, no external dependencies, deterministic.
 */

import { createHash } from "crypto"

// ---------------------------------------------------------------------------
// sha256
// ---------------------------------------------------------------------------

/**
 * Compute the SHA-256 hash of a string.
 *
 * Used to hash **actual file content read from disk** after a write,
 * never the raw tool payload from `ctx.params.content`.
 *
 * @param content - String content to hash
 * @returns 64-character lowercase hexadecimal digest
 */
export function sha256(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex")
}
