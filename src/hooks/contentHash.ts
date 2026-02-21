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
 * Compute the SHA-256 hash of content (Buffer or string).
 *
 * When a Buffer is passed, raw bytes are hashed without encoding —
 * this is mandatory for optimistic locking (Phase 4) to avoid
 * encoding-related inconsistencies with binary or special-char files.
 *
 * When a string is passed, utf8 encoding is used (Phase 3 compat).
 *
 * @param content - Buffer (preferred for disk reads) or string to hash
 * @returns 64-character lowercase hexadecimal digest
 */
export function sha256(content: Buffer | string): string {
	if (Buffer.isBuffer(content)) {
		return createHash("sha256").update(content).digest("hex")
	}
	return createHash("sha256").update(content, "utf8").digest("hex")
}
