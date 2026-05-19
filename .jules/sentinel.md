## 2024-03-06 - [CRITICAL] Fix unauthenticated setup API endpoints
**Vulnerability:** Setup API endpoints (`/api/setup` and `/api/setup/status`) were exposed without authentication, allowing any unauthenticated user to trigger database migrations, seed data, or view setup status.
**Learning:** The setup endpoints were created to simplify initial installation, but lacked the `validateSetupRequest` guard check that ensures `SETUP_MODE` is true and a valid `SETUP_TOKEN` is provided. The `setup-guard.ts` utility existed but was not applied to the actual route handlers.
**Prevention:** Ensure that all new API routes, especially administrative or setup-related ones, include appropriate authorization checks. A shared guard like `validateSetupRequest` should be implemented consistently across all related endpoints.

## 2024-03-08 - [HIGH] Fix Open Redirect vulnerability in login flow
**Vulnerability:** The `callbackUrl` parameter from `useSearchParams` was used directly in `router.push()` and `authClient.signIn` inside `src/components/auth/login-form.tsx` without validation.
**Learning:** This is an open redirect vulnerability because an attacker could send a user a link like `https://example.com/login?callbackUrl=https://malicious.com` and the user would be redirected to the malicious site after logging in. The system implicitly trusted the `callbackUrl` query string param.
**Prevention:** Validate user-provided redirect paths by ensuring they start with a single `/` and not `//`, forcing them to be relative paths on the same origin.

## 2025-03-08 - [CRITICAL] Fix Server-Side Request Forgery (SSRF) in OMR fetch endpoint
**Vulnerability:** The `fetchFileBuffer(fileUrl)` function in the OMR API endpoint accepted a `fileUrl` and blindly fetched it. Although intended for local files via `/api/files/...`, an attacker could potentially supply absolute URLs like `http://localhost:6379` or `http://169.254.169.254` (cloud metadata) and configure an external LLM endpoint to receive the base64-encoded response, successfully exfiltrating internal data.
**Learning:** Any backend `fetch()` or HTTP request that constructs a URL incorporating user-controlled or database-controlled input (like `storageKey`) can be manipulated to reach unintended internal or external destinations if absolute URLs are allowed.
**Prevention:** Strictly validate paths intended for local fetching. Ensure they start with a `/` and explicitly reject absolute protocols like `http://` and `https://` before constructing the final URL.
