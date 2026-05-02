---
"@tesseron/core": minor
---

fix: free the wire on action timeout/cancel even when the handler ignores `ctx.signal` (closes #85)

The SDK now races the handler against the abort signal, so a handler stuck inside a non-`AbortSignal`-aware promise (`modern-screenshot.domToPng`, `<canvas>.toBlob`, `<img>.decode`, `document.fonts.ready`, `Audio.play`, `MediaRecorder`, ...) no longer pins the agent's `tools/call` indefinitely. When the per-action `.timeout({ ms })` elapses or the agent sends `actions/cancel`, the SDK responds with `-32002 Timeout` or `-32001 Cancelled` immediately. The orphaned handler keeps running until it settles (still the app's job to clean up), but the agent is no longer held hostage.

Adds `ctx.withTimeout(value, ms)` for the in-handler companion: bound a single stuck inner call without giving the whole action a tighter outer timeout than it actually needs. Resolves on success, rejects with `TimeoutError` on the local deadline, and rejects with the abort reason if `ctx.signal` aborts first.

```ts
.handler(async (_input, ctx) => {
  const dataUrl = await ctx.withTimeout(domToPng(document.body), 8_000);
  return { dataUrl };
});
```
