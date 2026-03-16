# TODO

## Small things

- [ ] Submitting new messages should scroll to bottom
- [ ] Only show last 10 threads for a given project
- [ ] Thread archiving
- [ ] New projects should go on top
- [ ] Projects should be sorted by latest thread update

## Bigger things

- [ ] Queueing messages

I kept going and pushed the server-side OpenCode migration forward.
- Wired OpenCode into the live server provider graph in apps/server/src/serverLayers.ts.
- Updated the adapter registry to register both providers and expose enablement correctly in apps/server/src/provider/Layers/ProviderAdapterRegistry.ts.
- Reworked the OpenCode adapter to use direct HTTP/fetch calls instead of the speculative SDK wrapper in apps/server/src/provider/Layers/OpenCodeAdapter.ts, which removes the biggest compile/runtime risk from the prior attempt.
- Fixed OpenCode runtime event raw-source tagging to use opencode.* values, and added safer SSE subscription handling in apps/server/src/provider/Layers/OpenCodeAdapter.ts.
- Fixed the OpenCode runtime manager session mutability bug and made model/provider splitting explicit in apps/server/src/opencodeRuntimeManager.ts.
- Updated provider registry/service tests for the new isProviderEnabled contract and added a disabled-provider test in apps/server/src/provider/Layers/ProviderAdapterRegistry.test.ts and apps/server/src/provider/Layers/ProviderService.test.ts.
What is still blocked:
- I could not run bun fmt, bun lint, or bun typecheck because bun is not installed/on PATH in this environment, and there is no node_modules install present.
- So this is still unvalidated mechanically; the remaining risk is TypeScript/API mismatches I could not execute locally.
Most relevant files changed:
- apps/server/src/provider/Layers/OpenCodeAdapter.ts
- apps/server/src/opencodeRuntimeManager.ts
- apps/server/src/provider/Layers/ProviderAdapterRegistry.ts
- apps/server/src/serverLayers.ts
- apps/server/src/provider/Layers/ProviderAdapterRegistry.test.ts
- apps/server/src/provider/Layers/ProviderService.test.ts
Natural next steps:
1. Install/enable Bun in this environment and run bun fmt, bun lint, bun typecheck.
2. If those pass or are fixed, move to frontend defaults so OpenCode is the visible default and Codex is hidden by default.
3. After that, add a real OpenCode sidecar/process manager instead of assuming an already-running server at T3CODE_OPENCODE_BASE_URL / http://127.0.0.1:4096.