/**
 * Phase 4 — Read Hash Tracker
 *
 * In-memory map that records the SHA-256 hash of each file at the time
 * the agent reads it. Enables optimistic locking: before a write,
 * staleLockHook compares the current disk hash against the recorded
 * read hash. If they differ, the write is blocked.
 *
 * Session-scoped: resets on extension restart. After restart no reads
 * have occurred, so no staleness is possible.
 *
 * Protection scope (documented per tech lead requirement):
 * - Only protects files read during this session
 * - Does NOT protect files written without being read
 * - Does NOT persist across extension restarts
 * - Write→write without re-read is allowed (hash cleared after first write)
 */

import { canonicalizePath } from "./pathNormalize"

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Map of canonical file path → SHA-256 hash at read time. */
const readHashes = new Map<string, string>()

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/**
 * Record the hash of a file that was just read by the agent.
 * Overwrites any previous hash for the same path (latest read wins).
 * Path is canonicalized internally — callers pass raw paths.
 */
export function recordRead(cwd: string, filePath: string, contentHash: string): void {
    const key = canonicalizePath(filePath, cwd)
    readHashes.set(key, contentHash)
}

/**
 * Get the hash recorded when the agent last read this file.
 * Returns undefined if the file hasn't been read this session.
 * Path is canonicalized internally — callers pass raw paths.
 */
export function getReadHash(cwd: string, filePath: string): string | undefined {
    const key = canonicalizePath(filePath, cwd)
    return readHashes.get(key)
}

/**
 * Clear the recorded hash for a file after a successful write.
 * Called by traceSerializerHook AFTER full write success (not by staleLockHook).
 * Path is canonicalized internally — callers pass raw paths.
 */
export function clearRead(cwd: string, filePath: string): void {
    const key = canonicalizePath(filePath, cwd)
    readHashes.delete(key)
}

/**
 * Clear all recorded hashes. Used for testing only.
 */
export function clearAllReads(): void {
    readHashes.clear()
}
