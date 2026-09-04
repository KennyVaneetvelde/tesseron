---
'@tesseron/docs-mcp': patch
---

The C++ conformance page now reports the current corpus result (29 passed, 10
skipped) after the C++ host started answering a frame without `jsonrpc: "2.0"`
with a -32600 error instead of dropping it.
