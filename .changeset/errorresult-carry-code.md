---
"@tesseron/core": minor
"@tesseron/mcp": minor
---

Surface `TesseronErrorCode` in tool-call error results. The bridge's
`errorResult` helper now returns an MCP-spec-native `structuredContent`
object carrying the underlying `TesseronError`'s numeric `code` (and `data`,
when present), so agents can programmatically branch on `TransportClosed`
vs `HandlerError` vs `InputValidation` etc. instead of regex-matching the
text body. The structured shape is exported from `@tesseron/core` as
`TesseronStructuredError` for typed consumer access.

Before:

```jsonc
// tools/call response for a failed invocation
{
  "content": [{ "type": "text", "text": "Invalid input\n[...]" }],
  "isError": true
}
```

After:

```jsonc
{
  "content": [{ "type": "text", "text": "Invalid input\n{\n  \"code\": -32004,\n  \"data\": [...]\n}" }],
  "structuredContent": { "code": -32004, "data": [...] },
  "isError": true
}
```

The text body stays backwards-compatible (it still embeds the same shape
as `${message}\n${JSON}`), so existing log-scraping / regex assertions
keep passing. `structuredContent` is an optional field in
`CallToolResultSchema` from `@modelcontextprotocol/sdk`, so MCP clients
that ignore it are unaffected.

Call sites in `mcp-bridge.ts` now pass the full `TesseronError` to
`errorResult` rather than extracting `error.data` at the caller.
