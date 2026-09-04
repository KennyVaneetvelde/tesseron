---
'@tesseron/docs-mcp': patch
---

Add the C++ SDK to the docs snapshot: six pages under `sdk/cpp/` covering the
build, actions, resources, the `ActionContext`, and conformance, plus a row on
the compatibility page. The C++ host declares all four handshake capabilities
and leaves out host-minted claim codes and unix domain sockets, which is what
its 10 skipped conformance fixtures are.
