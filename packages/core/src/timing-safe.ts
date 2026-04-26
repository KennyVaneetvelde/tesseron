/**
 * Constant-time equality helpers.
 *
 * These are split into their own module rather than co-existing with the
 * dispatcher / builder code so the surface is obvious to security reviewers:
 * "every equality check on a user-presented token MUST go through this file."
 * Plain `a === b` on a short-circuiting comparison leaks a prefix-match
 * length to anyone measuring response latency, which is the textbook
 * timing-side-channel against bearer credentials (claim codes, resume
 * tokens, future host-minted bind tokens).
 *
 * Implementation is pure JavaScript so the helper works in browser bundles
 * too — `@tesseron/core` is the platform-neutral package and we don't want
 * to pull in `node:crypto` here. The XOR-and-OR loop runs in time
 * proportional to the input length regardless of where the strings differ;
 * a coarse statistical regression check in `test/timing-safe.test.ts`
 * fails loudly if a future "performance" refactor reintroduces a
 * short-circuit on prefix mismatch.
 */

/**
 * Constant-time string equality. Returns true iff `a` and `b` are the same
 * length and every character code matches. The XOR-and-OR loop runs in
 * time proportional to the input length regardless of where the strings
 * differ — a timing-side-channel attacker measuring response latency
 * cannot deduce a prefix match.
 *
 * **Length is a permitted side channel** because every Tesseron caller
 * passes fixed-length tokens (claim codes are `XXXX-XX`, resume tokens
 * are 32-char base64url, future host-minted bind tokens will be a fixed
 * shape). A length mismatch reduces to "definitely not this token,"
 * which the protocol shape already reveals; hiding it is unnecessary.
 *
 * **Unicode caveat.** `String.prototype.charCodeAt` returns UTF-16 code
 * units, not bytes. For ASCII-only inputs (which is what every Tesseron
 * token is — base64url, base32, and `XXXX-XX` codes are all in
 * `0x2D..0x7A`) this is byte-equivalent to a `Buffer.from(s).length`
 * comparison. If a future caller passes non-ASCII strings, the
 * constant-time guarantee still holds, but two strings whose UTF-16
 * representations differ at the same code-unit positions will compare
 * unequal even when their canonical Unicode form matches. Don't use
 * this helper for arbitrary user-supplied non-token strings.
 *
 * @throws TypeError if either argument is not a string. The TypeScript
 * signature already declares `string`, so a non-string at runtime is a
 * programmer error (untyped JS consumer, malformed deserialisation,
 * type-cast bypass) and should fail loudly rather than masquerade as a
 * misleading "token mismatch" — debugging that is hours of chasing the
 * wrong hypothesis.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') {
    throw new TypeError('constantTimeEqual requires two string arguments');
  }
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
