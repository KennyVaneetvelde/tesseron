---
'@tesseron/mcp': patch
'@tesseron/core': patch
'@tesseron/server': patch
'@tesseron/vite': patch
---

Harden every `~/.tesseron/*` write and switch all token generation to the platform CSPRNG. Foundations for tesseron#60 (claim-mediated transport binding); shipped on its own so the security improvements land without waiting for the larger architectural change.

**Filesystem hygiene.** Instance manifests (`~/.tesseron/instances/<id>.json`) and claim breadcrumbs (`~/.tesseron/claims/<CODE>.json`) are now written via a shared private-file helper that:

- creates the parent directory with mode `0o700` (and tightens an existing world-readable directory left over from a pre-hardening release);
- creates the file with mode `0o600` (owner-only read/write);
- writes atomically via a sibling temp file plus `rename`, so a concurrent reader never observes a partial write.

A sibling local process running as the same user can no longer enumerate or read the contents of `~/.tesseron/instances/` or `~/.tesseron/claims/` simply by walking the directory. (POSIX modes are advisory on Windows; the parent-dir-as-access-gate model documented for the UDS transport applies there too.)

**CSPRNG-sourced tokens.** Claim codes (`generateClaimCode`), session IDs (`generateSessionId`), and invocation IDs (`generateInvocationId`) now draw from `crypto.getRandomValues()` with rejection sampling instead of `Math.random()`. The claim code in particular is the user-typed gate between an unclaimed session and the MCP agent — a predictable PRNG meaningfully shrank the ~1.5-billion-combination space against an attacker measuring outputs. The wire format is unchanged (still `XXXX-XX` from a 31-char alphabet); only the entropy source differs.

**Constant-time compare.** A pure-JavaScript `constantTimeEqual` lands in `@tesseron/core/internal` and replaces the existing `node:crypto` `timingSafeEqual` used to validate `tesseron/resume` tokens. Same security property, but the helper is now reusable from browser-side code paths in upcoming PRs without pulling `node:crypto` into the web bundle.

No wire-protocol or public-API changes; the new symbols ship under `@tesseron/core/internal` (explicitly not part of the public contract). Existing tests cover unchanged; a new `fs-hygiene.test.ts` exercises mode bits and atomic-write semantics on POSIX, and a new `timing-safe.test.ts` includes a coarse statistical check that catches a regression to a short-circuiting comparison.
