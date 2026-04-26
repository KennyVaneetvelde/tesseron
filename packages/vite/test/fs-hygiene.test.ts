/**
 * Coverage for the {@link writePrivateFile} / {@link ensurePrivateDir} helpers
 * the Vite plugin (and its byte-identical siblings in `@tesseron/server` and
 * `@tesseron/mcp`) use for every `~/.tesseron/*` write.
 *
 * The mode-bit assertions only run on POSIX. Windows treats POSIX modes as
 * advisory; the parent-dir-as-access-gate model documented in the UDS
 * binding spec is the practical mitigation there. We still execute the
 * code path on Windows so a Windows-only crash regression doesn't slip
 * through; we just don't assert mode bits.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePrivateDir, writePrivateFile } from '../src/fs-hygiene.js';

let sandbox: string;

const isWindows = process.platform === 'win32';

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'tesseron-fs-hygiene-test-'));
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe('ensurePrivateDir', () => {
  it('creates a missing directory', async () => {
    const dir = join(sandbox, 'created');
    await ensurePrivateDir(dir);
    expect(statSync(dir).isDirectory()).toBe(true);
  });

  it('is idempotent for an existing directory', async () => {
    const dir = join(sandbox, 'idempotent');
    await ensurePrivateDir(dir);
    await ensurePrivateDir(dir);
    expect(statSync(dir).isDirectory()).toBe(true);
  });

  it.skipIf(isWindows)('sets mode 0o700 on a freshly created directory', async () => {
    const dir = join(sandbox, 'fresh-mode');
    await ensurePrivateDir(dir);
    // mode bits are the lower 9 of the stat mode field on POSIX.
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it.skipIf(isWindows)('tightens an existing directory to 0o700', async () => {
    // Pre-existing umask-default mode (typically 0o755). The hygiene helper
    // is supposed to chmod it down so an upgrade from a pre-hardening
    // release doesn't leave `~/.tesseron/` world-readable.
    const { mkdirSync, chmodSync } = await import('node:fs');
    const dir = join(sandbox, 'pre-existing');
    mkdirSync(dir);
    chmodSync(dir, 0o755);
    expect(statSync(dir).mode & 0o777).toBe(0o755);

    await ensurePrivateDir(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
});

describe('writePrivateFile', () => {
  it('writes the requested contents to the target path', async () => {
    const target = join(sandbox, 'simple.txt');
    await writePrivateFile(target, 'hello world');
    expect(readFileSync(target, 'utf8')).toBe('hello world');
  });

  it('creates the parent directory if missing', async () => {
    const target = join(sandbox, 'auto-parent', 'file.txt');
    await writePrivateFile(target, '{"v":1}');
    expect(readFileSync(target, 'utf8')).toBe('{"v":1}');
  });

  it('overwrites an existing file atomically (no leftover temp)', async () => {
    const target = join(sandbox, 'overwrite.txt');
    await writePrivateFile(target, 'first');
    await writePrivateFile(target, 'second');
    expect(readFileSync(target, 'utf8')).toBe('second');

    // No `.tmp.<pid>.<rand>` siblings should linger after a successful write.
    const dirEntries = readdirSync(sandbox);
    expect(dirEntries.filter((n) => n.includes('overwrite.txt.tmp'))).toEqual([]);
  });

  it.skipIf(isWindows)('writes the file with mode 0o600', async () => {
    const target = join(sandbox, 'mode-check.txt');
    await writePrivateFile(target, 'private');
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it.skipIf(isWindows)('preserves 0o600 on overwrite', async () => {
    const target = join(sandbox, 'mode-overwrite.txt');
    await writePrivateFile(target, 'first');
    // chmod the file to a looser mode then rewrite — the helper should
    // re-tighten it. Otherwise a manual `chmod 644` on a single file would
    // persist past the next refresh and silently leak data going forward.
    const { chmodSync } = await import('node:fs');
    chmodSync(target, 0o644);
    await writePrivateFile(target, 'second');
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it('handles concurrent writes to the same target without corruption', async () => {
    // Atomic temp+rename means a reader observes either the previous or
    // the new file, never a mixture. Spawn N concurrent writers each with
    // a distinct payload; final state should equal exactly one of the
    // contended payloads.
    //
    // Windows quirk: `rename` on Windows can return EPERM when two
    // concurrent renames target the same path because the destination is
    // briefly held open by the OS during the rename. POSIX rename has no
    // such restriction. This isn't a production concern — instance IDs
    // and claim codes are unique per writer, so production code never
    // fights for the same path — but the test contrives the race for
    // atomicity coverage. We tolerate per-call EPERMs on Windows; what
    // matters is that the *surviving* write is uncorrupted.
    const target = join(sandbox, 'concurrent.txt');
    const payloads = Array.from({ length: 10 }, (_, i) => `payload-${i}`);
    const results = await Promise.allSettled(payloads.map((p) => writePrivateFile(target, p)));
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBeGreaterThan(0);
    const final = readFileSync(target, 'utf8');
    expect(payloads).toContain(final);
  });

  it('a reader never observes a partial or empty file mid-write', async () => {
    // The whole point of temp+rename is: a concurrent reader sees either
    // the previous contents or the new contents, never a half-written
    // mixture and never a zero-length file. The earlier "concurrent
    // writes" test only checked the *final* state of the target. This
    // one explicitly observes the file *while* writes are in flight,
    // and asserts every read lands on one of the contended payloads in
    // full.
    //
    // A regression that switched the implementation to a direct
    // `writeFile(target, ...)` (losing atomicity) would surface here as
    // either a zero-length read between truncation and the first
    // payload byte, or a short read while bytes are still being
    // streamed in. Either failure mode is detected immediately.
    const target = join(sandbox, 'partial-write.txt');
    const { readFileSync: readSync, existsSync } = await import('node:fs');

    // Use payloads large enough that a non-atomic write would have a
    // realistic chance of being observed mid-flight, but small enough
    // that the test stays fast: 4 KB each.
    const payloadA = 'A'.repeat(4096);
    const payloadB = 'B'.repeat(4096);

    await writePrivateFile(target, payloadA);

    let stop = false;
    const writer = (async () => {
      for (let i = 0; i < 50 && !stop; i++) {
        const payload = i % 2 === 0 ? payloadB : payloadA;
        try {
          await writePrivateFile(target, payload);
        } catch {
          // Tolerate Windows EPERM-on-concurrent-rename; the failed
          // write leaves the target at its pre-write payload, which
          // is still one of the two valid observations.
        }
      }
    })();

    const observations: string[] = [];
    const reader = (async () => {
      while (!stop) {
        if (existsSync(target)) {
          observations.push(readSync(target, 'utf8'));
        }
        // Yield the event loop so the writer's microtasks run.
        await new Promise<void>((r) => setImmediate(r));
      }
    })();

    await writer;
    stop = true;
    await reader;

    expect(observations.length).toBeGreaterThan(0);
    for (const obs of observations) {
      // Every observation must be exactly one of the two payloads.
      // A truncated/empty/mixed read fails the assertion.
      expect(obs === payloadA || obs === payloadB).toBe(true);
    }
  });

  it('cleans up stray .tmp.* files after a successful write', async () => {
    // Repeated writes should not accumulate temp files in the parent dir.
    // Asserts we either rename or unlink the temp every time, never leak.
    const target = join(sandbox, 'no-leak.txt');
    for (let i = 0; i < 5; i++) {
      await writePrivateFile(target, `iteration-${i}`);
    }
    const stragglers = readdirSync(sandbox).filter((n) => n.startsWith('no-leak.txt.tmp.'));
    expect(stragglers).toEqual([]);
  });
});
