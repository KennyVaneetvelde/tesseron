# @tesseron/conformance

## 1.2.1

### Patch Changes

- [`13385ca`](https://github.com/Eigenwise/tesseron/commit/13385ca5e4ab6d2536f03662884d9423d8f797c2) by @Eigenwise - A relative `--host` path now works on Windows. The host is launched through a shell and cmd.exe ends the command token at the first slash, so `--host "build/tesseron-conformance-host"` died as `'build' is not recognized` before the host process existed. A `--host` that is nothing but a path is now resolved to its quoted absolute form; a command with arguments is left alone.

- [`aaae5fc`](https://github.com/Eigenwise/tesseron/commit/aaae5fcae007ad65352e406d6b38c40c73eeb5d0) by @Eigenwise - Published tarballs now include the LICENSE file.
