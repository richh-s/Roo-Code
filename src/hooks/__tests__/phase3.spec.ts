/**
 * Phase 3 — Unit Tests
 *
 * Tests for the AI-Native Git Layer: traceSchema, pathNormalize,
 * contentHash, mutationClassifier, and traceSerializerHook.
 *
 * Uses vi.mock for fs/promises (no memfs dependency).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import path from "path"

// ---------------------------------------------------------------------------
// Mock fs/promises
// ---------------------------------------------------------------------------
const mockReadFile = vi.fn()
const mockAppendFile = vi.fn()
const mockMkdir = vi.fn()
const mockStat = vi.fn()

vi.mock("fs/promises", () => ({
	default: {
		readFile: (...args: unknown[]) => mockReadFile(...args),
		appendFile: (...args: unknown[]) => mockAppendFile(...args),
		mkdir: (...args: unknown[]) => mockMkdir(...args),
		stat: (...args: unknown[]) => mockStat(...args),
	},
	readFile: (...args: unknown[]) => mockReadFile(...args),
	appendFile: (...args: unknown[]) => mockAppendFile(...args),
	mkdir: (...args: unknown[]) => mockMkdir(...args),
	stat: (...args: unknown[]) => mockStat(...args),
}))

// Mock child_process.execFile for git rev-parse
vi.mock("child_process", () => ({
	execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb?: (...args: unknown[]) => void) => {
		if (typeof _opts === "function") {
			cb = _opts as (...args: unknown[]) => void
		}
		if (_cmd === "git" && _args[0] === "rev-parse") {
			if (cb) cb(null, { stdout: "abc123def456\n", stderr: "" })
		} else {
			if (cb) cb(new Error("Unknown command"))
		}
	}),
}))

// Import AFTER mocks
import { sha256 } from "../contentHash"
import { canonicalizePath } from "../pathNormalize"
import { classifyMutation, recordWrite, resetClassifierCache } from "../mutationClassifier"
import { WRITE_TOOLS, DELETE_TOOLS, TRACE_LEDGER_PATH } from "../traceSchema"
import type { AgentTraceEntry } from "../traceSchema"
import { traceSerializerHook, resetTraceSerializerState } from "../traceSerializerHook"
import type { HookContext } from "../types"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CWD = "/test-workspace"

function makeLedgerJson(overrides: Partial<AgentTraceEntry> = {}): string {
	return JSON.stringify({
		id: "test-uuid-001",
		timestamp: "2025-01-01T00:00:00.000Z",
		tool: "write_to_file",
		intentId: "refactor-auth",
		mutationClass: "INTENT_EVOLUTION",
		mutationType: "WRITE",
		filePath: "src/auth/login.ts",
		contentHash: "a".repeat(64),
		outcome: "success",
		...overrides,
	})
}

function buildCtx(overrides: Partial<HookContext> = {}): HookContext {
	return {
		toolName: "write_to_file",
		params: { path: "src/auth/login.ts", content: "new content" },
		cwd: CWD,
		activeIntentId: "refactor-auth",
		...overrides,
	}
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
	vi.clearAllMocks()
	resetClassifierCache()
	resetTraceSerializerState()

	// Default mocks
	mockMkdir.mockResolvedValue(undefined)
	mockAppendFile.mockResolvedValue(undefined)
})

// ═══════════════════════════════════════════════════════════════════════════
// 1. sha256
// ═══════════════════════════════════════════════════════════════════════════

describe("contentHash — sha256", () => {
	it("returns expected 64-char hex for 'hello'", () => {
		const hash = sha256("hello")
		expect(hash).toHaveLength(64)
		expect(hash).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824")
	})

	it("returns different hashes for different content", () => {
		expect(sha256("foo")).not.toBe(sha256("bar"))
	})

	it("is deterministic", () => {
		expect(sha256("test")).toBe(sha256("test"))
	})
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. canonicalizePath
// ═══════════════════════════════════════════════════════════════════════════

describe("pathNormalize — canonicalizePath", () => {
	it("normalizes ./prefix", () => {
		expect(canonicalizePath("./src/file.ts", CWD)).toBe("src/file.ts")
	})

	it("normalizes backslashes to forward slashes", () => {
		const result = canonicalizePath("src\\auth\\login.ts", CWD)
		expect(result).toBe("src/auth/login.ts")
	})

	it("removes redundant segments", () => {
		expect(canonicalizePath("src/./auth/../file.ts", CWD)).toBe("src/file.ts")
	})

	it("handles absolute paths within workspace", () => {
		expect(canonicalizePath(`${CWD}/src/file.ts`, CWD)).toBe("src/file.ts")
	})
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. mutationClassifier
// ═══════════════════════════════════════════════════════════════════════════

describe("mutationClassifier", () => {
	it("returns INTENT_EVOLUTION for empty ledger", async () => {
		// ENOENT — no ledger file exists
		mockReadFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))

		const result = await classifyMutation(CWD, "refactor-auth", "src/auth/login.ts")
		expect(result).toBe("INTENT_EVOLUTION")
	})

	it("returns AST_REFACTOR when prior successful write exists", async () => {
		mockReadFile.mockResolvedValue(
			makeLedgerJson({
				intentId: "refactor-auth",
				filePath: "src/auth/login.ts",
				outcome: "success",
				mutationType: "WRITE",
			}) + "\n",
		)

		const result = await classifyMutation(CWD, "refactor-auth", "src/auth/login.ts")
		expect(result).toBe("AST_REFACTOR")
	})

	it("returns INTENT_EVOLUTION for different intent on same file", async () => {
		mockReadFile.mockResolvedValue(
			makeLedgerJson({
				intentId: "optimize-billing",
				filePath: "src/auth/login.ts",
				outcome: "success",
				mutationType: "WRITE",
			}) + "\n",
		)

		const result = await classifyMutation(CWD, "refactor-auth", "src/auth/login.ts")
		expect(result).toBe("INTENT_EVOLUTION")
	})

	it("ignores DELETE entries for classification", async () => {
		mockReadFile.mockResolvedValue(
			makeLedgerJson({
				intentId: "refactor-auth",
				filePath: "src/auth/login.ts",
				outcome: "success",
				mutationType: "DELETE",
			}) + "\n",
		)

		const result = await classifyMutation(CWD, "refactor-auth", "src/auth/login.ts")
		expect(result).toBe("INTENT_EVOLUTION")
	})

	it("ignores error entries for classification", async () => {
		mockReadFile.mockResolvedValue(
			makeLedgerJson({
				intentId: "refactor-auth",
				filePath: "src/auth/login.ts",
				outcome: "error",
				mutationType: "WRITE",
			}) + "\n",
		)

		const result = await classifyMutation(CWD, "refactor-auth", "src/auth/login.ts")
		expect(result).toBe("INTENT_EVOLUTION")
	})

	it("handles malformed JSONL lines without crashing", async () => {
		const ledger =
			"not valid json\n" +
			makeLedgerJson({ intentId: "refactor-auth", filePath: "src/auth/login.ts" }) +
			"\n" +
			"{broken\n"
		mockReadFile.mockResolvedValue(ledger)

		const result = await classifyMutation(CWD, "refactor-auth", "src/auth/login.ts")
		expect(result).toBe("AST_REFACTOR")
	})

	it("returns AST_REFACTOR after restart (reads ledger)", async () => {
		mockReadFile.mockResolvedValue(
			makeLedgerJson({
				intentId: "refactor-auth",
				filePath: "src/auth/login.ts",
				outcome: "success",
				mutationType: "WRITE",
			}) + "\n",
		)

		// First call builds cache
		await classifyMutation(CWD, "refactor-auth", "src/auth/login.ts")

		// Simulate restart
		resetClassifierCache()

		const result = await classifyMutation(CWD, "refactor-auth", "src/auth/login.ts")
		expect(result).toBe("AST_REFACTOR")
	})

	it("recordWrite updates in-memory cache", async () => {
		mockReadFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))

		// Initialize cache (empty)
		const first = await classifyMutation(CWD, "refactor-auth", "src/new.ts")
		expect(first).toBe("INTENT_EVOLUTION")

		// Record a write in cache
		recordWrite("refactor-auth", "src/new.ts")

		// Should now be AST_REFACTOR from cache
		const second = await classifyMutation(CWD, "refactor-auth", "src/new.ts")
		expect(second).toBe("AST_REFACTOR")
	})
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. traceSchema constants
// ═══════════════════════════════════════════════════════════════════════════

describe("traceSchema — constants", () => {
	it("WRITE_TOOLS contains expected tools", () => {
		expect(WRITE_TOOLS.has("write_to_file")).toBe(true)
		expect(WRITE_TOOLS.has("apply_diff")).toBe(true)
		expect(WRITE_TOOLS.has("apply_patch")).toBe(true)
		expect(WRITE_TOOLS.has("search_replace")).toBe(true)
	})

	it("DELETE_TOOLS contains delete_file", () => {
		expect(DELETE_TOOLS.has("delete_file")).toBe(true)
	})

	it("WRITE_TOOLS does not contain read tools", () => {
		expect(WRITE_TOOLS.has("read_file")).toBe(false)
		expect(WRITE_TOOLS.has("list_files")).toBe(false)
	})
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. traceSerializerHook
// ═══════════════════════════════════════════════════════════════════════════

describe("traceSerializerHook", () => {
	beforeEach(() => {
		// Default: classifier reads empty ledger
		mockReadFile.mockImplementation(async (filePath: string) => {
			if (filePath.includes(TRACE_LEDGER_PATH)) {
				throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
			}
			// Default file content for disk hashing
			return "const x = 1;"
		})
		mockStat.mockResolvedValue({ size: 12 })
	})

	it("skips non-write tools", async () => {
		const ctx = buildCtx({ toolName: "read_file" })
		await traceSerializerHook(ctx, { success: true })

		await new Promise((r) => setTimeout(r, 50))

		expect(mockAppendFile).not.toHaveBeenCalled()
	})

	it("skips when no activeIntentId", async () => {
		const ctx = buildCtx({ activeIntentId: undefined })
		await traceSerializerHook(ctx, { success: true })

		await new Promise((r) => setTimeout(r, 50))

		expect(mockAppendFile).not.toHaveBeenCalled()
	})

	it("writes valid JSONL for successful write_to_file", async () => {
		const ctx = buildCtx()
		await traceSerializerHook(ctx, { success: true })

		await new Promise((r) => setTimeout(r, 100))

		expect(mockMkdir).toHaveBeenCalledWith(path.join(CWD, ".orchestration"), { recursive: true })
		expect(mockAppendFile).toHaveBeenCalledTimes(1)

		const appendCall = mockAppendFile.mock.calls[0]
		const entry = JSON.parse(appendCall[1].replace("\n", "")) as AgentTraceEntry

		expect(entry.id).toBeDefined()
		expect(entry.timestamp).toBeDefined()
		expect(entry.tool).toBe("write_to_file")
		expect(entry.intentId).toBe("refactor-auth")
		expect(entry.mutationClass).toBe("INTENT_EVOLUTION")
		expect(entry.mutationType).toBe("WRITE")
		expect(entry.filePath).toBe("src/auth/login.ts")
		expect(entry.contentHash).toHaveLength(64)
		expect(entry.outcome).toBe("success")
		expect(entry.toolArgsSnapshot).toEqual({ path: "src/auth/login.ts" })
	})

	it("handles ENOENT gracefully (contentHash = null)", async () => {
		// All readFile calls throw ENOENT (ledger and disk)
		mockReadFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))

		const ctx = buildCtx({
			params: { path: "src/nonexistent.ts", content: "x" },
		})
		await traceSerializerHook(ctx, { success: false, error: "write failed" })

		await new Promise((r) => setTimeout(r, 100))

		expect(mockAppendFile).toHaveBeenCalledTimes(1)
		const appendCall = mockAppendFile.mock.calls[0]
		const entry = JSON.parse(appendCall[1].replace("\n", "")) as AgentTraceEntry

		expect(entry.contentHash).toBeNull()
		expect(entry.outcome).toBe("error")
		expect(entry.error).toBe("write failed")
	})

	it("detects delete tool by toolName", async () => {
		// readFile for disk content will ENOENT (file was deleted)
		mockReadFile.mockImplementation(async (filePath: string) => {
			if (filePath.includes(TRACE_LEDGER_PATH)) {
				throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
			}
			throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
		})

		const ctx = buildCtx({
			toolName: "delete_file",
			params: { path: "src/auth/old.ts" },
		})
		await traceSerializerHook(ctx, { success: true })

		await new Promise((r) => setTimeout(r, 100))

		expect(mockAppendFile).toHaveBeenCalledTimes(1)
		const entry = JSON.parse(mockAppendFile.mock.calls[0][1].replace("\n", "")) as AgentTraceEntry

		expect(entry.mutationType).toBe("DELETE")
		expect(entry.contentHash).toBeNull()
	})

	it("failed write has mutationType WRITE not DELETE", async () => {
		// File doesn't exist after failed write
		mockReadFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))

		const ctx = buildCtx({
			params: { path: "src/auth/fail.ts", content: "x" },
		})
		await traceSerializerHook(ctx, { success: false, error: "disk error" })

		await new Promise((r) => setTimeout(r, 100))

		expect(mockAppendFile).toHaveBeenCalledTimes(1)
		const entry = JSON.parse(mockAppendFile.mock.calls[0][1].replace("\n", "")) as AgentTraceEntry

		expect(entry.mutationType).toBe("WRITE")
		expect(entry.outcome).toBe("error")
	})

	it("produces unique UUIDs for different entries", async () => {
		const ctx = buildCtx()
		await traceSerializerHook(ctx, { success: true })
		await traceSerializerHook(ctx, { success: true })

		await new Promise((r) => setTimeout(r, 100))

		expect(mockAppendFile).toHaveBeenCalledTimes(2)
		const entry1 = JSON.parse(mockAppendFile.mock.calls[0][1].replace("\n", "")) as AgentTraceEntry
		const entry2 = JSON.parse(mockAppendFile.mock.calls[1][1].replace("\n", "")) as AgentTraceEntry

		expect(entry1.id).not.toBe(entry2.id)
	})

	it("includes fileSizeBytes when file exists", async () => {
		mockStat.mockResolvedValue({ size: 42 })

		const ctx = buildCtx()
		await traceSerializerHook(ctx, { success: true })

		await new Promise((r) => setTimeout(r, 100))

		expect(mockAppendFile).toHaveBeenCalledTimes(1)
		const entry = JSON.parse(mockAppendFile.mock.calls[0][1].replace("\n", "")) as AgentTraceEntry

		expect(entry.fileSizeBytes).toBe(42)
	})
})
