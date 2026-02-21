# CLAUDE.md — Shared Brain

> Auto-maintained by the lesson recorder hook.
> Each entry below was captured from a command execution failure.

---

## Lesson Learned — 2026-02-21T17:06:14Z

- **Intent:** refactor-auth
- **Command:** `npx tsc --noEmit`
- **Error:** `src/auth/login.ts(42,7): error TS2322: Type 'string' is not assignable to type 'number'. The expected type comes from property 'sessionTimeout' which is declared here in 'AuthConfig'.`
- **Takeaway:** When refactoring the auth module, `sessionTimeout` was changed to accept a string duration format like `"30m"` but the `AuthConfig` interface still declares it as `number`. Update the interface before changing the implementation.

---

## Lesson Learned — 2026-02-21T17:14:52Z

- **Intent:** refactor-auth
- **Command:** `npm test -- --run src/auth/__tests__/login.spec.ts`
- **Error:** `FAIL src/auth/__tests__/login.spec.ts > validateCredentials > should reject expired sessions. AssertionError: expected 'active' to be 'expired'. Session state not updated after timeout period.`
- **Takeaway:** The `validateCredentials` function caches session state. After modifying the timeout logic, the cached state must be invalidated. Call `session.invalidateCache()` before re-checking status.

---

## Lesson Learned — 2026-02-21T18:35:20Z

- **Intent:** optimize-billing
- **Command:** `npx tsc --noEmit`
- **Error:** `src/billing/invoice.ts(87,3): error TS2345: Argument of type 'InvoiceItem[]' is not assignable to parameter of type 'readonly InvoiceItem[]'. Property 'push' is missing in type 'readonly InvoiceItem[]'.`
- **Takeaway:** The `calculateTotal` optimization changed the parameter to accept `readonly InvoiceItem[]` for immutability, but callers pass mutable arrays. Either keep the parameter as `InvoiceItem[]` or update all call sites.
