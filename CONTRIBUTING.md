# Contributing to Tesseron

Thanks for your interest. Contributions are welcome — bug reports, protocol
refinements, example apps, new framework adapters, or reference-implementation
improvements.

## Licensing

Tesseron's reference implementation is **Business Source License 1.1**
(source-available, converts to Apache-2.0 four years after each release).
The protocol specification under `docs/src/content/docs/protocol/` is
**CC BY 4.0** and may be reimplemented freely.

By submitting a contribution you agree that your changes are licensed on the
same terms as the file you're editing.

## Developer Certificate of Origin (DCO)

Every commit **must be signed off** under the [Developer Certificate of
Origin v1.1](https://developercertificate.org/). That certificate is a simple
statement that you wrote the code (or otherwise have the right to submit it)
and are contributing it under the project's license.

Sign off by appending a `Signed-off-by:` line to your commit message:

```
Signed-off-by: Your Name <you@example.com>
```

Git does this for you automatically if you pass `-s`:

```bash
git commit -s -m "your message"
```

The email must match the one attached to the commit (the one shown by
`git config user.email`). Pull requests without sign-off will be asked to
fix up history before merge.

## Getting started

```bash
pnpm install
pnpm typecheck
pnpm test
```

See [`README.md`](./README.md) for the package layout, and
[`examples/`](./examples) for working example apps to develop against.

## Submitting changes

1. Open an issue first for anything larger than a small bug fix or doc tweak,
   so design direction is aligned before you spend time on a patch.
2. Keep pull requests focused — one logical change per PR.
3. Include tests for protocol or dispatcher behavior changes. The existing
   test suite in `packages/core/test/` and `packages/mcp/test/` is the
   source of truth for expected behavior.
4. Run `pnpm typecheck` and `pnpm test` locally before pushing.
5. Make sure every commit is `Signed-off-by:`.

## Code of conduct

Be civil, be specific, assume good faith.
