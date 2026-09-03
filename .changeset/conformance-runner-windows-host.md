---
'@tesseron/conformance': patch
---

A relative `--host` path now works on Windows. The host is launched through a shell and cmd.exe ends the command token at the first slash, so `--host "build/tesseron-conformance-host"` died as `'build' is not recognized` before the host process existed. A `--host` that is nothing but a path is now resolved to its quoted absolute form; a command with arguments is left alone.
