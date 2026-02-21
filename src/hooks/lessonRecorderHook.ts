/**
 * Phase 4 — Lesson Recorder Post-Hook
 *
 * Fires after `execute_command` failures. Records verification failures
 * (tests, lint, type errors) to CLAUDE.md for agent learning.
 *
 * Key design decisions:
 * - Aggressive noise filtering — only verification failures recorded
 * - 800-char hard cap with ANSI stripping
 * - Duplicate suppression via sha256 dedup key
 * - Never crashes, never overrides original command failure
 * - Intent fallback to "unknown"
 */

import fs from "fs/promises"
import path from "path"
import { createHash } from "crypto"

import type { PostHookFn } from "./types"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLAUDE_MD = "CLAUDE.md"
const MAX_ERROR_LENGTH = 800
const MAX_DEDUP_SET_SIZE = 200

// ---------------------------------------------------------------------------
// Pattern Sets — Noise Filtering
// ---------------------------------------------------------------------------

/**
 * Patterns that indicate a genuine verification failure.
 * Error must match at least one of these to be recorded.
 */
const VERIFICATION_PATTERNS: RegExp[] = [
    /FAIL/i,
    /Tests?:.*failed/i,
    /AssertionError/i,
    /AssertionError/i,
    /error TS\d+/i,
    /TypeError/i,
    /ReferenceError/i,
    /SyntaxError/i,
    /Compilation failed/i,
    /✖.*problems?/,
    /ELIFECYCLE/,
    /Build failed/i,
    /lint.*error/i,
    /exit code [1-9]/i,
    /exited \(\d+\)/,
]

/**
 * Patterns for transient/environmental errors — skip these.
 * Checked BEFORE verification patterns.
 */
const NOISE_PATTERNS: RegExp[] = [
    /ENOTFOUND/,
    /ETIMEDOUT/,
    /ECONNREFUSED/,
    /ECONNRESET/,
    /command not found/i,
    /EACCES/,
    /EPERM/,
    /ENOMEM/,
    /ENOSPC/,
    /getaddrinfo/,
    /certificate/i,
    /socket hang up/i,
]

// ---------------------------------------------------------------------------
// ANSI Strip
// ---------------------------------------------------------------------------

const ANSI_REGEX = /\x1b\[[0-9;]*m/g

function stripAnsi(text: string): string {
    return text.replace(ANSI_REGEX, "")
}

// ---------------------------------------------------------------------------
// Dedup Set
// ---------------------------------------------------------------------------

const loggedLessons = new Set<string>()

function dedupKey(command: string, error: string): string {
    const prefix = error.slice(0, 200)
    return createHash("sha256").update(command + prefix, "utf8").digest("hex")
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function isVerificationFailure(error: string): boolean {
    // Skip if it matches noise patterns
    for (const pattern of NOISE_PATTERNS) {
        if (pattern.test(error)) {
            return false
        }
    }
    // Must match at least one verification pattern
    for (const pattern of VERIFICATION_PATTERNS) {
        if (pattern.test(error)) {
            return true
        }
    }
    return false
}

// ---------------------------------------------------------------------------
// Lesson Recorder Post-Hook
// ---------------------------------------------------------------------------

export const lessonRecorderHook: PostHookFn = async (ctx, outcome) => {
    // Only fire for execute_command failures
    if (ctx.toolName !== "execute_command") return
    if (outcome.success) return
    if (!outcome.error) return

    try {
        const errorText = stripAnsi(outcome.error)

        // Noise filter — skip transient/environmental errors
        if (!isVerificationFailure(errorText)) return

        const command = typeof ctx.params.command === "string" ? ctx.params.command : "<unknown>"
        const intentId = ctx.activeIntentId ?? "unknown"

        // Duplicate suppression
        const key = dedupKey(command, errorText)
        if (loggedLessons.has(key)) return

        // Cap dedup Set size to prevent unbounded memory growth
        if (loggedLessons.size >= MAX_DEDUP_SET_SIZE) {
            loggedLessons.clear()
        }
        loggedLessons.add(key)

        // Truncate error output
        const truncated = errorText.length > MAX_ERROR_LENGTH
            ? errorText.slice(0, MAX_ERROR_LENGTH) + "…[truncated]"
            : errorText

        const timestamp = new Date().toISOString()
        const lesson = [
            `## Lesson Learned — ${timestamp}`,
            ``,
            `- **Intent:** ${intentId}`,
            `- **Command:** \`${command}\``,
            `- **Error:**`,
            "```",
            truncated,
            "```",
            `- **Takeaway:** Verification step failed. Review the error output and adjust the implementation.`,
        ].join("\n")

        const claudePath = path.join(ctx.cwd, CLAUDE_MD)

        // Read existing content (or empty string if missing)
        let existing = ""
        try {
            existing = await fs.readFile(claudePath, "utf8")
        } catch {
            // File doesn't exist — will be created
        }

        // Append lesson (never overwrite)
        const separator = existing.trim() ? "\n\n---\n\n" : ""
        await fs.writeFile(claudePath, existing + separator + lesson + "\n", "utf8")
    } catch (err) {
        // Never override original command failure — log only
        console.warn("[LessonRecorder] Hook error (non-fatal):", err)
    }
}

/**
 * Reset dedup set. Used for testing only.
 */
export function resetLessonDedup(): void {
    loggedLessons.clear()
}
