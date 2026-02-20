/**
 * Phase 4 — Unit Tests
 *
 * Tests for:
 * - readHashTracker (buffer hashing, canonical paths, clear)
 * - staleLockHook (match, mismatch, deleted, fail-open, no prior read)
 * - lessonRecorderHook (noise filter, dedup, cap, ANSI strip, intent fallback)
 * - contentHash (Buffer | string)
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("fs/promises", () => ({
    default: {
        readFile: vi.fn(),
        writeFile: vi.fn(),
        stat: vi.fn(),
    },
    readFile: vi.fn(),
    writeFile: vi.fn(),
    stat: vi.fn(),
}))

import fs from "fs/promises"
import { sha256 } from "../contentHash"
import { recordRead, getReadHash, clearRead, clearAllReads } from "../readHashTracker"
import { staleLockHook } from "../staleLockHook"
import { lessonRecorderHook, resetLessonDedup } from "../lessonRecorderHook"

const mockReadFile = vi.mocked(fs.readFile)
const mockWriteFile = vi.mocked(fs.writeFile)

const CWD = "/workspace"

// ---------------------------------------------------------------------------
// contentHash — Buffer | string
// ---------------------------------------------------------------------------

describe("contentHash", () => {
    it("1: hashes Buffer and string to same value for identical content", () => {
        const content = "hello world"
        const buffer = Buffer.from(content, "utf8")
        expect(sha256(buffer)).toBe(sha256(content))
    })

    it("2: returns 64-char hex digest", () => {
        const hash = sha256(Buffer.from("test"))
        expect(hash).toMatch(/^[a-f0-9]{64}$/)
    })
})

// ---------------------------------------------------------------------------
// readHashTracker
// ---------------------------------------------------------------------------

describe("readHashTracker", () => {
    beforeEach(() => {
        clearAllReads()
    })

    it("3: records and retrieves read hash", () => {
        recordRead(CWD, "src/foo.ts", "abc123")
        expect(getReadHash(CWD, "src/foo.ts")).toBe("abc123")
    })

    it("4: returns undefined for unread file", () => {
        expect(getReadHash(CWD, "src/bar.ts")).toBeUndefined()
    })

    it("5: canonical path consistency — different raw paths resolve to same key", () => {
        recordRead(CWD, "src/../src/foo.ts", "hash1")
        expect(getReadHash(CWD, "src/foo.ts")).toBe("hash1")
    })

    it("6: clearRead removes hash", () => {
        recordRead(CWD, "src/foo.ts", "abc123")
        clearRead(CWD, "src/foo.ts")
        expect(getReadHash(CWD, "src/foo.ts")).toBeUndefined()
    })

    it("7: latest read wins (overwrites)", () => {
        recordRead(CWD, "src/foo.ts", "hash1")
        recordRead(CWD, "src/foo.ts", "hash2")
        expect(getReadHash(CWD, "src/foo.ts")).toBe("hash2")
    })
})

// ---------------------------------------------------------------------------
// staleLockHook
// ---------------------------------------------------------------------------

describe("staleLockHook", () => {
    beforeEach(() => {
        clearAllReads()
        vi.clearAllMocks()
    })

    const ctx = (toolName: string, params: Record<string, unknown>) => ({
        toolName,
        params,
        cwd: CWD,
        activeIntentId: "intent-1",
    })

    it("8: matching hash → proceed", async () => {
        const content = Buffer.from("hello world")
        const hash = sha256(content)
        recordRead(CWD, "src/foo.ts", hash)

        mockReadFile.mockResolvedValue(content as never)

        const result = await staleLockHook(ctx("write_to_file", { path: "src/foo.ts" }))
        expect(result.proceed).toBe(true)
    })

    it("9: mismatched hash → STALE_FILE error", async () => {
        recordRead(CWD, "src/foo.ts", sha256(Buffer.from("original")))

        mockReadFile.mockResolvedValue(Buffer.from("modified") as never)

        const result = await staleLockHook(ctx("write_to_file", { path: "src/foo.ts" }))
        expect(result.proceed).toBe(false)
        expect(result.error).toContain("STALE_FILE")
        expect(result.reason).toContain("modified since last read")
    })

    it("10: no prior read → proceed", async () => {
        const result = await staleLockHook(ctx("write_to_file", { path: "src/new.ts" }))
        expect(result.proceed).toBe(true)
    })

    it("11: deleted file → STALE_FILE with null hash", async () => {
        recordRead(CWD, "src/foo.ts", "somehash")

        const enoent = new Error("ENOENT") as NodeJS.ErrnoException
        enoent.code = "ENOENT"
        mockReadFile.mockRejectedValue(enoent as never)

        const result = await staleLockHook(ctx("write_to_file", { path: "src/foo.ts" }))
        expect(result.proceed).toBe(false)
        const payload = JSON.parse(result.error!)
        expect(payload.error.details.currentHash).toBeNull()
    })

    it("12: non-write tool → skip (proceed)", async () => {
        const result = await staleLockHook(ctx("read_file", { path: "src/foo.ts" }))
        expect(result.proceed).toBe(true)
    })

    it("13: hook read error → fail-open (proceed)", async () => {
        recordRead(CWD, "src/foo.ts", "somehash")

        mockReadFile.mockRejectedValue(new Error("disk I/O error") as never)

        const result = await staleLockHook(ctx("write_to_file", { path: "src/foo.ts" }))
        expect(result.proceed).toBe(true)
    })

    it("14: apply_patch extracts path from patch content", async () => {
        const content = Buffer.from("hello")
        const hash = sha256(content)
        recordRead(CWD, "src/auth/login.ts", hash)

        mockReadFile.mockResolvedValue(content as never)

        const result = await staleLockHook(
            ctx("apply_patch", {
                patch: "*** Update File: src/auth/login.ts\nsome patch content",
            }),
        )
        expect(result.proceed).toBe(true)
    })
})

// ---------------------------------------------------------------------------
// lessonRecorderHook
// ---------------------------------------------------------------------------

describe("lessonRecorderHook", () => {
    beforeEach(() => {
        resetLessonDedup()
        vi.clearAllMocks()
        mockReadFile.mockRejectedValue(new Error("ENOENT") as never) // CLAUDE.md doesn't exist
        mockWriteFile.mockResolvedValue(undefined as never)
    })

    const ctx = (command: string, intentId?: string) => ({
        toolName: "execute_command",
        params: { command },
        cwd: CWD,
        activeIntentId: intentId,
    })

    it("15: verification failure → lesson in CLAUDE.md", async () => {
        await lessonRecorderHook(ctx("npm test", "intent-1"), {
            success: false,
            error: "Tests: 3 failed, 2 passed",
        })
        expect(mockWriteFile).toHaveBeenCalledTimes(1)
        const written = mockWriteFile.mock.calls[0][1] as string
        expect(written).toContain("Lesson Learned")
        expect(written).toContain("intent-1")
        expect(written).toContain("npm test")
    })

    it("16: network error → no lesson (noise filtered)", async () => {
        await lessonRecorderHook(ctx("npm install"), {
            success: false,
            error: "ENOTFOUND registry.npmjs.org",
        })
        expect(mockWriteFile).not.toHaveBeenCalled()
    })

    it("17: successful command → no lesson", async () => {
        await lessonRecorderHook(ctx("npm test", "intent-1"), {
            success: true,
        })
        expect(mockWriteFile).not.toHaveBeenCalled()
    })

    it("18: non-execute_command → no lesson", async () => {
        await lessonRecorderHook(
            { toolName: "write_to_file", params: {}, cwd: CWD },
            { success: false, error: "some error" },
        )
        expect(mockWriteFile).not.toHaveBeenCalled()
    })

    it("19: duplicate command+error → single lesson", async () => {
        const outcome = { success: false as const, error: "FAIL: test broke" }
        await lessonRecorderHook(ctx("npm test", "i1"), outcome)
        await lessonRecorderHook(ctx("npm test", "i1"), outcome)
        expect(mockWriteFile).toHaveBeenCalledTimes(1)
    })

    it("20: error > 800 chars → truncated", async () => {
        const longError = "FAIL " + "x".repeat(1000)
        await lessonRecorderHook(ctx("npm test", "i1"), {
            success: false,
            error: longError,
        })
        const written = mockWriteFile.mock.calls[0][1] as string
        expect(written).toContain("…[truncated]")
        // Content between ``` blocks should be ≤ 800 + truncation marker
        const codeMatch = written.match(/```\n([\s\S]*?)\n```/)
        expect(codeMatch![1].length).toBeLessThanOrEqual(800 + 12) // 12 = "…[truncated]"
    })

    it("21: ANSI codes stripped", async () => {
        await lessonRecorderHook(ctx("npm test", "i1"), {
            success: false,
            error: "\x1b[31mFAIL\x1b[0m test.ts",
        })
        const written = mockWriteFile.mock.calls[0][1] as string
        expect(written).not.toContain("\x1b[")
        expect(written).toContain("FAIL test.ts")
    })

    it("22: missing intent → fallback to 'unknown'", async () => {
        await lessonRecorderHook(ctx("npx tsc --noEmit", undefined), {
            success: false,
            error: "error TS2304: Cannot find name 'foo'",
        })
        const written = mockWriteFile.mock.calls[0][1] as string
        expect(written).toContain("**Intent:** unknown")
    })

    it("23: existing CLAUDE.md → appended with separator", async () => {
        mockReadFile.mockResolvedValue("# Existing rules\n" as never)
        await lessonRecorderHook(ctx("npm test", "i1"), {
            success: false,
            error: "FAIL: assertion error",
        })
        const written = mockWriteFile.mock.calls[0][1] as string
        expect(written).toMatch(/# Existing rules\n+\n---\n\n## Lesson Learned/)
    })
})
