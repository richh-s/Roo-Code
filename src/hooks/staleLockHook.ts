/**
 * Phase 4 — Stale File Lock Pre-Hook
 *
 * Implements optimistic locking by comparing the current disk hash
 * against the hash recorded when the agent last read the file.
 * If different, the file was modified externally and the write is blocked.
 *
 * Key design decisions:
 * - First pre-hook in pipeline (before scope, before auth) — fail fast
 * - Uses raw Buffer hashing — never utf8 strings
 * - Does NOT clear hash on match — clearRead runs in traceSerializerHook
 *   only after full write success (prevents false unlock if later hooks block)
 * - Fail-open: if hook itself errors → allow write, log warning
 * - Deleted file → treated as stale with currentHash: null
 */

import fs from "fs/promises"
import path from "path"

import type { PreHookFn } from "./types"
import { WRITE_TOOLS } from "./traceSchema"
import { sha256 } from "./contentHash"
import { canonicalizePath } from "./pathNormalize"
import { getReadHash } from "./readHashTracker"

// ---------------------------------------------------------------------------
// File Path Extraction (shared logic with traceSerializerHook)
// ---------------------------------------------------------------------------

function extractFilePath(toolName: string, params: Record<string, unknown>): string | undefined {
    if (typeof params.path === "string" && params.path) {
        return params.path
    }
    if (typeof params.file_path === "string" && params.file_path) {
        return params.file_path
    }
    if (toolName === "apply_patch" && typeof params.patch === "string") {
        const match = params.patch.match(/\*{3}\s+(?:Update|Add|Delete|Rename)\s+File:\s+(.+?)$/m)
        if (match?.[1]) {
            return match[1].trim()
        }
    }
    return undefined
}

// ---------------------------------------------------------------------------
// Error Payload Builder
// ---------------------------------------------------------------------------

function buildStaleError(
    filePath: string,
    readHash: string,
    currentHash: string | null,
    remedy: string,
): { proceed: false; error: string; reason: string } {
    return {
        proceed: false as const,
        error: JSON.stringify({
            status: "error",
            message: "STALE_FILE: File modified since last read. Re-read before writing.",
            error: {
                code: "STALE_FILE",
                details: { filePath, readHash, currentHash, remedy },
            },
        }),
        reason: `Stale file: ${filePath} ${currentHash === null ? "deleted" : "modified"} since last read`,
    }
}

// ---------------------------------------------------------------------------
// Stale Lock Pre-Hook
// ---------------------------------------------------------------------------

export const staleLockHook: PreHookFn = async (ctx) => {
    // Only check write-class tools
    if (!WRITE_TOOLS.has(ctx.toolName)) {
        return { proceed: true }
    }

    const rawPath = extractFilePath(ctx.toolName, ctx.params)
    if (!rawPath) {
        return { proceed: true }
    }

    try {
        const filePath = canonicalizePath(rawPath, ctx.cwd)
        const readHash = getReadHash(ctx.cwd, filePath)

        // No recorded hash → file wasn't read this session (or new file) → proceed
        if (!readHash) {
            return { proceed: true }
        }

        const resolvedPath = path.resolve(ctx.cwd, filePath)
        let diskHash: string

        try {
            // Raw buffer hashing — never utf8 strings
            const buffer = await fs.readFile(resolvedPath)
            diskHash = sha256(buffer)
        } catch (readErr: unknown) {
            // File deleted externally → stale
            if (readErr instanceof Error && (readErr as NodeJS.ErrnoException).code === "ENOENT") {
                return buildStaleError(
                    filePath,
                    readHash,
                    null,
                    "File no longer exists. Use read_file to confirm, then re-create if needed.",
                )
            }
            // Other read error → fail-open, allow write, log warning
            console.warn("[StaleLock] Unexpected read error, allowing write:", readErr)
            return { proceed: true }
        }

        // Compare hashes
        if (diskHash !== readHash) {
            return buildStaleError(
                filePath,
                readHash,
                diskHash,
                "Call read_file(path) to get the latest version, then retry.",
            )
        }

        // Hashes match — proceed (do NOT clear hash here)
        return { proceed: true }
    } catch (err) {
        // Fail-open: hook error → allow write, log warning
        console.warn("[StaleLock] Hook error (non-fatal), allowing write:", err)
        return { proceed: true }
    }
}
