/**
 * Filesystem hygiene helpers for `~/.tesseron/*` writes.
 *
 * Tesseron writes a handful of small files under `~/.tesseron/` (instance
 * manifests, claim breadcrumbs, future runtime state). Every one of those
 * files is locally sensitive: another process running as the same user can
 * read them, and a few of them carry tokens or about-to-be-tokens that the
 * threat model assumes only the owning gateway sees. The shipped writers
 * predate any explicit hardening, so they used the umask default (typically
 * world-readable 0o644 on Linux) and a non-atomic `writeFile`. This helper
 * standardises the contract:
 *
 *   - parent dir is forced to 0o700 (best-effort on filesystems that ignore
 *     POSIX modes);
 *   - file is created with mode 0o600 — owner-only read/write;
 *   - the write is atomic via a sibling temp file plus `rename`; because the
 *     temp lives in the same directory as the target, the rename is
 *     guaranteed same-filesystem and is atomic on POSIX and on Windows ≥ 10.
 *
 * Byte-identical copies of this file ship in `@tesseron/vite`,
 * `@tesseron/server`, and `@tesseron/mcp`. Three copies is cheaper than
 * wiring a new shared package or making `@tesseron/vite` depend on
 * `@tesseron/server` just for ~100 lines of disk plumbing. A drift-detection
 * test in `@tesseron/mcp` (which transitively owns the other two) hashes
 * all three at test time and fails if they diverge — see
 * `packages/mcp/test/fs-hygiene-parity.test.ts`.
 */

import { constants as fsConstants } from 'node:fs';
import { chmod, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

/**
 * Ensure `dir` exists with restrictive (0o700) permissions.
 *
 * On creation the mode flows through `mkdir({ mode })`. For a pre-existing
 * directory (e.g. a `~/.tesseron/` left behind by a pre-hardening release
 * with the umask-default 0o755), an explicit `chmod` tightens it down so
 * the documented "manifests are owner-only on POSIX" guarantee actually
 * holds after an upgrade.
 *
 * **Failure handling.** If the post-create `chmod` fails on a POSIX system,
 * the directory may remain readable by other local processes — the very
 * threat the helper exists to mitigate. We log the failure to stderr (with
 * the resolved path so an operator can act on it) but do not throw, because
 * a write that fails outright is worse than a write that lands at a looser
 * mode: the gateway would refuse to register the manifest and the user's
 * tab would silently fail to connect. On Windows, EPERM here is the
 * documented advisory-mode no-op and is suppressed.
 */
export async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  try {
    await chmod(dir, PRIVATE_DIR_MODE);
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException).code;
    // Windows treats POSIX modes as advisory; chmod on a directory
    // typically returns EPERM and the OS user model is the gate. The
    // UDS-binding spec already documents this caveat.
    if (process.platform === 'win32' && errno === 'EPERM') return;
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[tesseron] failed to tighten ${dir} to 0o700: ${reason} — directory may be readable by other local processes; see docs/protocol/security\n`,
    );
  }
}

/**
 * Atomically write `contents` to `targetPath` with mode 0o600.
 *
 * Atomicity: the write goes to `<targetPath>.tmp.<pid>.<random>`, then
 * `rename`s into place. The temp lives next to the target, so the rename
 * is same-filesystem by construction and atomic on POSIX and on Windows
 * ≥ 10 (the only platforms Node 20 targets). A concurrent reader observes
 * either the previous file or the new one — never a half-written one.
 *
 * Mode: the file is created with mode 0o600 (owner-only). The chmod after
 * the write covers filesystems that ignored the open-time mode argument
 * — when *that* path matters and *that* chmod also fails, the security
 * claim is undermined, so the failure is logged to stderr (mirroring
 * {@link ensurePrivateDir}). The atomic-rename still happens; better a
 * loosely-permissioned manifest than a dropped write that strands the
 * user's session.
 *
 * Symlink safety is enforced upstream: the parent directory is set to
 * 0o700 by {@link ensurePrivateDir}, which means an attacker without write
 * access to the directory cannot pre-plant a symlink inside it, so a
 * regular `rename` into the dir is safe to trust without extra
 * `O_NOFOLLOW` acrobatics. (On Windows POSIX modes are advisory and the
 * OS user model is the gate — same caveat as the UDS transport,
 * documented there.)
 */
export async function writePrivateFile(targetPath: string, contents: string): Promise<void> {
  const dir = dirname(targetPath);
  await ensurePrivateDir(dir);

  const tmp = `${targetPath}.tmp.${process.pid}.${randomSuffix()}`;
  // O_EXCL: refuse to clobber a pre-existing file at the temp path. With
  // 64 random bits in the suffix the realistic role of O_EXCL is to catch
  // a sibling process that picked the same name (vanishingly unlikely)
  // — useful insurance, not the primary atomicity guarantee.
  const fh = await open(
    tmp,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
    PRIVATE_FILE_MODE,
  );
  try {
    await fh.writeFile(contents);
    try {
      await fh.chmod(PRIVATE_FILE_MODE);
    } catch (err) {
      const errno = (err as NodeJS.ErrnoException).code;
      if (process.platform === 'win32' && errno === 'EPERM') {
        // Windows advisory-mode no-op; suppress.
      } else {
        const reason = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[tesseron] failed to tighten ${tmp} to 0o600: ${reason} — file may be readable by other local processes\n`,
        );
      }
    }
  } finally {
    await fh.close();
  }

  try {
    await rename(tmp, targetPath);
  } catch (err) {
    // Cleanup is best-effort, but a leaked temp accumulates over time and
    // is operator-actionable. Surface anything other than ENOENT (which
    // means a sibling already cleaned the temp, e.g. a process exit
    // handler) to stderr.
    try {
      await unlink(tmp);
    } catch (cleanupErr) {
      const cleanupCode = (cleanupErr as NodeJS.ErrnoException).code;
      if (cleanupCode !== 'ENOENT') {
        const reason = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
        process.stderr.write(`[tesseron] leaked temp file ${tmp}: ${reason}\n`);
      }
    }
    throw err;
  }
}

/**
 * 16-hex-character random suffix used for atomic-write temp filenames.
 * CSPRNG-sourced (via Web Crypto) so a sibling process picking the same
 * name is statistically impossible — the `O_EXCL` open is just belt-and-
 * braces against the worst-case collision.
 */
function randomSuffix(): string {
  const c = globalThis.crypto;
  if (!c?.getRandomValues) {
    throw new Error(
      'platform CSPRNG (crypto.getRandomValues) is unavailable; cannot generate temp-file suffix',
    );
  }
  const buf = new Uint8Array(8);
  c.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}
