/**
 * Phase 3 — Path Normalization
 *
 * Cross-platform canonical path normalization for ledger keys.
 * All trace operations pass through this before classification,
 * ledger write, or key generation.
 */

import path from "path"

// ---------------------------------------------------------------------------
// canonicalizePath
// ---------------------------------------------------------------------------

/**
 * Normalize a file path to canonical form for ledger keys.
 *
 * Guarantees:
 * - Resolves against workspace root (`cwd`)
 * - Converts to relative POSIX path
 * - Removes redundant segments (`./`, `../`)
 * - Forward slashes only (cross-platform safe)
 *
 * Examples:
 *   canonicalizePath("./src/file.ts", cwd)       → "src/file.ts"
 *   canonicalizePath("src\\auth\\login.ts", cwd) → "src/auth/login.ts"
 *   canonicalizePath("src/./auth/../file.ts", cwd) → "src/file.ts"
 *
 * @param targetPath - File path (absolute or relative)
 * @param cwd        - Workspace root directory
 * @returns Canonical relative POSIX path
 */
export function canonicalizePath(targetPath: string, cwd: string): string {
	const absolute = path.resolve(cwd, targetPath)
	return path.posix.normalize(path.relative(cwd, absolute).replace(/\\/g, "/"))
}
