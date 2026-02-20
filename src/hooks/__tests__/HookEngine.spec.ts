/**
 * Phase 2 — HookEngine Unit Tests (Hardened)
 *
 * Tests for the Hook Engine, command classifier (3-tier), scope enforcer
 * (path traversal + 3-button modal), authorization hook, and tool error builder.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock vscode before importing modules that use it
vi.mock("vscode", () => ({
	window: {
		showWarningMessage: vi.fn(),
	},
}))

// Mock fs for intentIgnore and pendingScopeUpdates
vi.mock("fs", () => ({
	readFileSync: vi.fn(),
	existsSync: vi.fn(),
	writeFileSync: vi.fn(),
	mkdirSync: vi.fn(),
}))

// Mock activeIntents for scope enforcer
vi.mock("../../core/context/activeIntents", () => ({
	isGovernedWorkspace: vi.fn(),
	loadActiveIntents: vi.fn(),
	findIntentById: vi.fn(),
}))

import * as vscode from "vscode"
import * as fs from "fs"
import { classifyTool, classifyWithPath, isSensitivePath, isExplicitlyDestructive } from "../commandClassifier"
import {
	buildToolError,
	buildScopeViolationError,
	buildAuthorizationRejectedError,
	buildPathTraversalError,
	buildSensitiveReadError,
	HookErrorCode,
} from "../toolError"
import { parseIntentIgnore, isIgnoredByIntent } from "../intentIgnore"
import { isPathInScope, extractTargetPath, checkScopeViolation, normaliseAndValidatePath } from "../scopeEnforcer"
import { scopeEnforcerHook } from "../scopeEnforcer"
import { authorizationHook } from "../authorizationHook"
import { HookEngine } from "../HookEngine"
import { isGovernedWorkspace, loadActiveIntents, findIntentById } from "../../core/context/activeIntents"
import type { HookContext } from "../types"

// ============================================================================
// Command Classification
// ============================================================================

describe("commandClassifier", () => {
	describe("classifyTool (name-only)", () => {
		it("classifies read-only tools as safe", () => {
			expect(classifyTool("read_file")).toBe("safe")
			expect(classifyTool("search_files")).toBe("safe")
			expect(classifyTool("list_files")).toBe("safe")
			expect(classifyTool("codebase_search")).toBe("safe")
		})

		it("classifies meta tools as safe", () => {
			expect(classifyTool("ask_followup_question")).toBe("safe")
			expect(classifyTool("attempt_completion")).toBe("safe")
			expect(classifyTool("select_active_intent")).toBe("safe")
		})

		it("classifies writing tools as destructive", () => {
			expect(classifyTool("write_to_file")).toBe("destructive")
			expect(classifyTool("execute_command")).toBe("destructive")
		})

		it("classifies unknown tools as destructive", () => {
			expect(classifyTool("some_unknown_tool")).toBe("destructive")
		})
	})

	describe("classifyWithPath (path-aware)", () => {
		it("returns safe for read_file on normal files", () => {
			expect(classifyWithPath("read_file", { path: "src/auth/login.ts" })).toBe("safe")
		})

		it("returns sensitive for read_file on .env", () => {
			expect(classifyWithPath("read_file", { path: ".env" })).toBe("sensitive")
		})

		it("returns sensitive for read_file on .env.production", () => {
			expect(classifyWithPath("read_file", { path: ".env.production" })).toBe("sensitive")
		})

		it("returns sensitive for read_file on .pem files", () => {
			expect(classifyWithPath("read_file", { path: "certs/server.pem" })).toBe("sensitive")
		})

		it("returns sensitive for read_file on .key files", () => {
			expect(classifyWithPath("read_file", { path: "ssl/private.key" })).toBe("sensitive")
		})

		it("returns sensitive for read_file on id_rsa", () => {
			expect(classifyWithPath("read_file", { path: ".ssh/id_rsa" })).toBe("sensitive")
		})

		it("returns sensitive for read_file on .orchestration/ files", () => {
			expect(classifyWithPath("read_file", { path: ".orchestration/active_intents.yaml" })).toBe("sensitive")
		})

		it("returns sensitive for read_file on secrets.* files", () => {
			expect(classifyWithPath("read_file", { path: "config/secrets.yaml" })).toBe("sensitive")
			expect(classifyWithPath("read_file", { path: "credentials.json" })).toBe("sensitive")
		})

		it("returns destructive for write_to_file regardless of path", () => {
			expect(classifyWithPath("write_to_file", { path: ".env" })).toBe("destructive")
		})

		it("returns safe for read_file with no params", () => {
			expect(classifyWithPath("read_file", {})).toBe("safe")
		})
	})

	describe("isSensitivePath", () => {
		it("detects .env files", () => {
			expect(isSensitivePath(".env")).toBe(true)
			expect(isSensitivePath(".env.local")).toBe(true)
			expect(isSensitivePath(".env.staging")).toBe(true)
		})

		it("detects key files", () => {
			expect(isSensitivePath("server.pem")).toBe(true)
			expect(isSensitivePath("private.key")).toBe(true)
			expect(isSensitivePath("keystore.p12")).toBe(true)
		})

		it("detects SSH keys", () => {
			expect(isSensitivePath("id_rsa")).toBe(true)
			expect(isSensitivePath("id_ed25519")).toBe(true)
		})

		it("does not flag normal files", () => {
			expect(isSensitivePath("src/auth/login.ts")).toBe(false)
			expect(isSensitivePath("README.md")).toBe(false)
			expect(isSensitivePath("package.json")).toBe(false)
		})
	})

	describe("isExplicitlyDestructive", () => {
		it("returns true for known destructive tools", () => {
			expect(isExplicitlyDestructive("write_to_file")).toBe(true)
			expect(isExplicitlyDestructive("execute_command")).toBe(true)
		})

		it("returns false for unknown tools", () => {
			expect(isExplicitlyDestructive("some_unknown_tool")).toBe(false)
		})
	})
})

// ============================================================================
// Tool Error Builder
// ============================================================================

describe("toolError", () => {
	describe("buildToolError", () => {
		it("produces valid JSON with correct shape", () => {
			const result = buildToolError(HookErrorCode.HOOK_BLOCKED, "Test message")
			const parsed = JSON.parse(result)

			expect(parsed.status).toBe("error")
			expect(parsed.message).toBe("Test message")
			expect(parsed.error.code).toBe("HOOK_BLOCKED")
		})

		it("includes details when provided", () => {
			const result = buildToolError(HookErrorCode.HOOK_BLOCKED, "msg", { foo: "bar" })
			const parsed = JSON.parse(result)
			expect(parsed.error.details).toEqual({ foo: "bar" })
		})

		it("includes suggestedFix when provided", () => {
			const result = buildToolError(HookErrorCode.HOOK_BLOCKED, "msg", undefined, "Try this instead")
			const parsed = JSON.parse(result)
			expect(parsed.error.suggestedFix).toBe("Try this instead")
		})

		it("omits details and suggestedFix when not provided", () => {
			const result = buildToolError(HookErrorCode.HOOK_BLOCKED, "msg")
			const parsed = JSON.parse(result)
			expect(parsed.error).not.toHaveProperty("details")
			expect(parsed.error).not.toHaveProperty("suggestedFix")
		})
	})

	describe("buildScopeViolationError", () => {
		it("contains intent, file, scope, and suggestedFix", () => {
			const result = buildScopeViolationError("refactor-auth", "src/billing/invoice.ts", ["src/auth/*"])
			const parsed = JSON.parse(result)

			expect(parsed.error.code).toBe("SCOPE_VIOLATION")
			expect(parsed.error.details.intentId).toBe("refactor-auth")
			expect(parsed.error.details.requestedPath).toBe("src/billing/invoice.ts")
			expect(parsed.error.details.allowedScope).toEqual(["src/auth/*"])
			expect(parsed.error.suggestedFix).toBeDefined()
			expect(parsed.error.suggestedFix).toContain("expand the scope")
		})
	})

	describe("buildAuthorizationRejectedError", () => {
		it("contains tool name, rejection, and suggestedFix", () => {
			const result = buildAuthorizationRejectedError("write_to_file", "refactor-auth")
			const parsed = JSON.parse(result)

			expect(parsed.error.code).toBe("AUTHORIZATION_REJECTED")
			expect(parsed.message).toContain("write_to_file")
			expect(parsed.error.suggestedFix).toBeDefined()
			expect(parsed.error.suggestedFix).toContain("different approach")
		})
	})

	describe("buildPathTraversalError", () => {
		it("contains the path, workspace, and suggestedFix", () => {
			const result = buildPathTraversalError("../config.ts", "/workspace")
			const parsed = JSON.parse(result)

			expect(parsed.error.code).toBe("PATH_TRAVERSAL")
			expect(parsed.error.details.requestedPath).toBe("../config.ts")
			expect(parsed.error.details.workspaceRoot).toBe("/workspace")
			expect(parsed.error.suggestedFix).toContain("workspace-relative")
		})
	})

	describe("buildSensitiveReadError", () => {
		it("contains the file path and suggestedFix", () => {
			const result = buildSensitiveReadError("read_file", ".env")
			const parsed = JSON.parse(result)

			expect(parsed.error.code).toBe("SENSITIVE_READ_BLOCKED")
			expect(parsed.error.details.filePath).toBe(".env")
			expect(parsed.error.suggestedFix).toContain("secret files")
		})
	})
})

// ============================================================================
// Intent Ignore
// ============================================================================

describe("intentIgnore", () => {
	describe("parseIntentIgnore", () => {
		it("parses lines and skips comments and blanks", () => {
			const content = `
# Comment
dist/
*.log

node_modules/
# Another comment
`
			const patterns = parseIntentIgnore(content)
			expect(patterns).toEqual(["dist/", "*.log", "node_modules/"])
		})

		it("returns empty array for empty content", () => {
			expect(parseIntentIgnore("")).toEqual([])
		})
	})

	describe("isIgnoredByIntent", () => {
		it("matches prefix (directory)", () => {
			expect(isIgnoredByIntent("dist/index.js", ["dist/"])).toBe(true)
		})

		it("matches suffix (extension)", () => {
			expect(isIgnoredByIntent("app.log", ["*.log"])).toBe(true)
			expect(isIgnoredByIntent("src/debug.log", ["*.log"])).toBe(true)
		})

		it("matches contains (node_modules)", () => {
			expect(isIgnoredByIntent("foo/node_modules/bar.js", ["node_modules"])).toBe(true)
		})

		it("does not match unrelated paths", () => {
			expect(isIgnoredByIntent("src/auth/login.ts", ["dist/", "*.log"])).toBe(false)
		})

		it("returns false for empty patterns", () => {
			expect(isIgnoredByIntent("anything.ts", [])).toBe(false)
		})
	})
})

// ============================================================================
// Scope Enforcer
// ============================================================================

describe("scopeEnforcer", () => {
	describe("isPathInScope", () => {
		it("allows everything when scope is empty", () => {
			expect(isPathInScope("any/file.ts", [])).toBe(true)
		})

		it("matches exact path", () => {
			expect(isPathInScope("src/auth/login.ts", ["src/auth/login.ts"])).toBe(true)
		})

		it("matches single-level wildcard (dir/*)", () => {
			expect(isPathInScope("src/auth/login.ts", ["src/auth/*"])).toBe(true)
			expect(isPathInScope("src/auth/sub/deep.ts", ["src/auth/*"])).toBe(false)
		})

		it("matches recursive wildcard (dir/**)", () => {
			expect(isPathInScope("src/auth/login.ts", ["src/auth/**"])).toBe(true)
			expect(isPathInScope("src/auth/sub/deep.ts", ["src/auth/**"])).toBe(true)
		})

		it("matches plain directory prefix", () => {
			expect(isPathInScope("src/auth/login.ts", ["src/auth"])).toBe(true)
		})

		it("rejects out-of-scope paths", () => {
			expect(isPathInScope("src/billing/invoice.ts", ["src/auth/*"])).toBe(false)
		})
	})

	describe("normaliseAndValidatePath", () => {
		it("accepts workspace-relative paths", () => {
			const result = normaliseAndValidatePath("src/auth/login.ts", "/workspace")
			expect("relativePath" in result).toBe(true)
			if ("relativePath" in result) {
				expect(result.relativePath).toBe("src/auth/login.ts")
			}
		})

		it("blocks parent traversal (../)", () => {
			const result = normaliseAndValidatePath("../config/database.ts", "/workspace")
			expect("traversal" in result).toBe(true)
		})

		it("blocks deep parent traversal (../../)", () => {
			const result = normaliseAndValidatePath("../../etc/passwd", "/workspace")
			expect("traversal" in result).toBe(true)
		})

		it("blocks absolute paths outside workspace", () => {
			const result = normaliseAndValidatePath("/etc/passwd", "/workspace")
			expect("traversal" in result).toBe(true)
		})

		it("allows absolute paths within workspace", () => {
			const result = normaliseAndValidatePath("/workspace/src/file.ts", "/workspace")
			expect("relativePath" in result).toBe(true)
			if ("relativePath" in result) {
				expect(result.relativePath).toBe("src/file.ts")
			}
		})

		it("normalises ./ prefixed paths", () => {
			const result = normaliseAndValidatePath("./src/auth/login.ts", "/workspace")
			expect("relativePath" in result).toBe(true)
			if ("relativePath" in result) {
				expect(result.relativePath).toBe("src/auth/login.ts")
			}
		})
	})

	describe("extractTargetPath", () => {
		it("extracts 'path' param", () => {
			expect(extractTargetPath({ path: "src/file.ts" })).toBe("src/file.ts")
		})

		it("extracts 'file_path' param", () => {
			expect(extractTargetPath({ file_path: "src/file.ts" })).toBe("src/file.ts")
		})

		it("returns undefined when no path param exists", () => {
			expect(extractTargetPath({ command: "ls" })).toBeUndefined()
		})
	})

	describe("checkScopeViolation", () => {
		it("returns allowed for in-scope path", () => {
			const result = checkScopeViolation("src/auth/login.ts", "refactor-auth", ["src/auth/*"])
			expect(result.allowed).toBe(true)
		})

		it("returns violation for out-of-scope path", () => {
			const result = checkScopeViolation("src/billing/invoice.ts", "refactor-auth", ["src/auth/*"])
			expect(result.allowed).toBe(false)
			expect(result.violation).toContain("refactor-auth")
		})
	})

	describe("scopeEnforcerHook", () => {
		beforeEach(() => {
			vi.clearAllMocks()
		})

		it("proceeds when no active intent", async () => {
			const ctx: HookContext = {
				toolName: "write_to_file",
				params: { path: "src/auth/login.ts" },
				cwd: "/workspace",
			}
			const result = await scopeEnforcerHook(ctx)
			expect(result.proceed).toBe(true)
		})

		it("proceeds when tool has no file path param", async () => {
			vi.mocked(loadActiveIntents).mockResolvedValue([
				{ id: "test", goal: "test", status: "IN_PROGRESS", constraints: [], scope: ["src/auth/*"] },
			])
			vi.mocked(findIntentById).mockReturnValue({
				id: "test",
				goal: "test",
				status: "IN_PROGRESS",
				constraints: [],
				scope: ["src/auth/*"],
			})

			const ctx: HookContext = {
				toolName: "execute_command",
				params: { command: "ls" },
				cwd: "/workspace",
				activeIntentId: "test",
			}
			const result = await scopeEnforcerHook(ctx)
			expect(result.proceed).toBe(true)
		})

		it("blocks path traversal attempts", async () => {
			vi.mocked(loadActiveIntents).mockResolvedValue([
				{ id: "refactor-auth", goal: "g", status: "IN_PROGRESS", constraints: [], scope: ["src/auth/*"] },
			])
			vi.mocked(findIntentById).mockReturnValue({
				id: "refactor-auth",
				goal: "g",
				status: "IN_PROGRESS",
				constraints: [],
				scope: ["src/auth/*"],
			})
			vi.mocked(fs.readFileSync).mockImplementation(() => {
				throw new Error("ENOENT")
			})

			const ctx: HookContext = {
				toolName: "write_to_file",
				params: { path: "../config/database.ts" },
				cwd: "/workspace",
				activeIntentId: "refactor-auth",
			}
			const result = await scopeEnforcerHook(ctx)
			expect(result.proceed).toBe(false)

			const parsed = JSON.parse(result.error!)
			expect(parsed.error.code).toBe("PATH_TRAVERSAL")
			expect(parsed.error.suggestedFix).toContain("workspace-relative")
		})

		it("shows 3-button modal when file is outside scope and blocks on Reject", async () => {
			vi.mocked(loadActiveIntents).mockResolvedValue([
				{ id: "refactor-auth", goal: "g", status: "IN_PROGRESS", constraints: [], scope: ["src/auth/*"] },
			])
			vi.mocked(findIntentById).mockReturnValue({
				id: "refactor-auth",
				goal: "g",
				status: "IN_PROGRESS",
				constraints: [],
				scope: ["src/auth/*"],
			})
			vi.mocked(fs.readFileSync).mockImplementation(() => {
				throw new Error("ENOENT")
			})
			vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Reject" as any)

			const ctx: HookContext = {
				toolName: "write_to_file",
				params: { path: "src/billing/invoice.ts" },
				cwd: "/workspace",
				activeIntentId: "refactor-auth",
			}
			const result = await scopeEnforcerHook(ctx)
			expect(result.proceed).toBe(false)

			const parsed = JSON.parse(result.error!)
			expect(parsed.error.code).toBe("SCOPE_VIOLATION")
			expect(parsed.error.suggestedFix).toBeDefined()
		})

		it("allows one-time bypass on 'Approve Once'", async () => {
			vi.mocked(loadActiveIntents).mockResolvedValue([
				{ id: "refactor-auth", goal: "g", status: "IN_PROGRESS", constraints: [], scope: ["src/auth/*"] },
			])
			vi.mocked(findIntentById).mockReturnValue({
				id: "refactor-auth",
				goal: "g",
				status: "IN_PROGRESS",
				constraints: [],
				scope: ["src/auth/*"],
			})
			vi.mocked(fs.readFileSync).mockImplementation(() => {
				throw new Error("ENOENT")
			})
			vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Approve Once" as any)

			const ctx: HookContext = {
				toolName: "write_to_file",
				params: { path: "src/billing/invoice.ts" },
				cwd: "/workspace",
				activeIntentId: "refactor-auth",
			}
			const result = await scopeEnforcerHook(ctx)
			expect(result.proceed).toBe(true)
			expect(result.reason).toContain("one-time bypass")
		})

		it("allows and records expansion on 'Approve & Expand Scope'", async () => {
			vi.mocked(loadActiveIntents).mockResolvedValue([
				{ id: "refactor-auth", goal: "g", status: "IN_PROGRESS", constraints: [], scope: ["src/auth/*"] },
			])
			vi.mocked(findIntentById).mockReturnValue({
				id: "refactor-auth",
				goal: "g",
				status: "IN_PROGRESS",
				constraints: [],
				scope: ["src/auth/*"],
			})
			vi.mocked(fs.readFileSync).mockImplementation(() => {
				throw new Error("ENOENT")
			})
			vi.mocked(fs.existsSync).mockReturnValue(false)
			vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Approve & Expand Scope" as any)

			const ctx: HookContext = {
				toolName: "write_to_file",
				params: { path: "src/billing/invoice.ts" },
				cwd: "/workspace",
				activeIntentId: "refactor-auth",
			}
			const result = await scopeEnforcerHook(ctx)
			expect(result.proceed).toBe(true)
			expect(result.reason).toContain("scope expansion")

			// Verify pending scope update was written
			expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalled()
			const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0]
			expect(String(writeCall[0])).toContain("pending_scope_updates.json")
		})

		it("allows when file is within scope", async () => {
			vi.mocked(loadActiveIntents).mockResolvedValue([
				{ id: "refactor-auth", goal: "g", status: "IN_PROGRESS", constraints: [], scope: ["src/auth/*"] },
			])
			vi.mocked(findIntentById).mockReturnValue({
				id: "refactor-auth",
				goal: "g",
				status: "IN_PROGRESS",
				constraints: [],
				scope: ["src/auth/*"],
			})
			vi.mocked(fs.readFileSync).mockImplementation(() => {
				throw new Error("ENOENT")
			})

			const ctx: HookContext = {
				toolName: "write_to_file",
				params: { path: "src/auth/login.ts" },
				cwd: "/workspace",
				activeIntentId: "refactor-auth",
			}
			const result = await scopeEnforcerHook(ctx)
			expect(result.proceed).toBe(true)
		})
	})
})

// ============================================================================
// Authorization Hook
// ============================================================================

describe("authorizationHook", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("proceeds when user approves", async () => {
		vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Approve" as any)

		const ctx: HookContext = {
			toolName: "write_to_file",
			params: { path: "src/auth/login.ts" },
			cwd: "/workspace",
			activeIntentId: "refactor-auth",
		}
		const result = await authorizationHook(ctx)
		expect(result.proceed).toBe(true)
	})

	it("blocks when user rejects with suggestedFix in error", async () => {
		vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Reject" as any)

		const ctx: HookContext = {
			toolName: "write_to_file",
			params: { path: "src/auth/login.ts" },
			cwd: "/workspace",
			activeIntentId: "refactor-auth",
		}
		const result = await authorizationHook(ctx)
		expect(result.proceed).toBe(false)

		const parsed = JSON.parse(result.error!)
		expect(parsed.error.code).toBe("AUTHORIZATION_REJECTED")
		expect(parsed.error.suggestedFix).toBeDefined()
	})

	it("blocks when user dismisses dialog (undefined)", async () => {
		vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined as any)

		const ctx: HookContext = {
			toolName: "execute_command",
			params: { command: "rm -rf /" },
			cwd: "/workspace",
		}
		const result = await authorizationHook(ctx)
		expect(result.proceed).toBe(false)
	})
})

// ============================================================================
// HookEngine
// ============================================================================

describe("HookEngine", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("bypasses all hooks for safe tools on normal files", async () => {
		vi.mocked(isGovernedWorkspace).mockReturnValue(true)

		const engine = new HookEngine()
		const ctx: HookContext = {
			toolName: "read_file",
			params: { path: "src/auth/login.ts" },
			cwd: "/workspace",
			activeIntentId: "refactor-auth",
		}
		const result = await engine.runPre(ctx)
		expect(result.proceed).toBe(true)
		expect(ctx.classification).toBe("safe")
	})

	it("routes SENSITIVE tools to authorization only (skips scope)", async () => {
		vi.mocked(isGovernedWorkspace).mockReturnValue(true)
		vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Approve" as any)

		const engine = new HookEngine()
		const ctx: HookContext = {
			toolName: "read_file",
			params: { path: ".env" },
			cwd: "/workspace",
			activeIntentId: "refactor-auth",
		}
		const result = await engine.runPre(ctx)
		expect(result.proceed).toBe(true)
		expect(ctx.classification).toBe("sensitive")
		// Verify showWarningMessage was called (authorization triggered)
		expect(vscode.window.showWarningMessage).toHaveBeenCalled()
	})

	it("blocks SENSITIVE reads when user rejects", async () => {
		vi.mocked(isGovernedWorkspace).mockReturnValue(true)
		vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Reject" as any)

		const engine = new HookEngine()
		const ctx: HookContext = {
			toolName: "read_file",
			params: { path: ".env" },
			cwd: "/workspace",
			activeIntentId: "refactor-auth",
		}
		const result = await engine.runPre(ctx)
		expect(result.proceed).toBe(false)
		expect(ctx.classification).toBe("sensitive")
	})

	it("bypasses all hooks for ungoverned workspace", async () => {
		vi.mocked(isGovernedWorkspace).mockReturnValue(false)

		const engine = new HookEngine()
		const ctx: HookContext = {
			toolName: "write_to_file",
			params: { path: "src/auth/login.ts" },
			cwd: "/workspace",
		}
		const result = await engine.runPre(ctx)
		expect(result.proceed).toBe(true)
	})

	it("runs pre-hooks for destructive tools in governed mode", async () => {
		vi.mocked(isGovernedWorkspace).mockReturnValue(true)

		const engine = new HookEngine()
		engine.clearHooks()
		const mockHook = vi.fn().mockResolvedValue({ proceed: true })
		engine.addPreHook(mockHook)

		const ctx: HookContext = {
			toolName: "write_to_file",
			params: { path: "src/auth/login.ts" },
			cwd: "/workspace",
			activeIntentId: "refactor-auth",
		}
		const result = await engine.runPre(ctx)
		expect(result.proceed).toBe(true)
		expect(mockHook).toHaveBeenCalledOnce()
	})

	it("short-circuits on first blocking hook", async () => {
		vi.mocked(isGovernedWorkspace).mockReturnValue(true)

		const engine = new HookEngine()
		engine.clearHooks()

		const blockingHook = vi.fn().mockResolvedValue({
			proceed: false,
			error: '{"status":"error","message":"blocked"}',
		})
		const secondHook = vi.fn().mockResolvedValue({ proceed: true })

		engine.addPreHook(blockingHook)
		engine.addPreHook(secondHook)

		const ctx: HookContext = {
			toolName: "write_to_file",
			params: { path: "src/file.ts" },
			cwd: "/workspace",
			activeIntentId: "test",
		}
		const result = await engine.runPre(ctx)

		expect(result.proceed).toBe(false)
		expect(blockingHook).toHaveBeenCalledOnce()
		expect(secondHook).not.toHaveBeenCalled()
	})

	it("runs post-hooks without propagating errors", async () => {
		const engine = new HookEngine()
		const failingPostHook = vi.fn().mockRejectedValue(new Error("post-hook error"))
		engine.addPostHook(failingPostHook)

		const ctx: HookContext = {
			toolName: "write_to_file",
			params: {},
			cwd: "/workspace",
		}

		await expect(engine.runPost(ctx, { success: true })).resolves.toBeUndefined()
		expect(failingPostHook).toHaveBeenCalledOnce()
	})
})
