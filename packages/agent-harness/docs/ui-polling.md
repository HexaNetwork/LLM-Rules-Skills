# Dashboard background refresh contract

The dashboard polls while the tab is visible so operators can watch long-running
reflect / grill / implement work without manually refreshing. Polling must never
feel like a page reload.

This document is the checklist for that contract. Keep the tests in
`tests/unit/ui-app.test.ts` aligned with it.

## Refresh sources

| Source | Interval / trigger | Silent? | May rewrite run DOM? |
| --- | --- | --- | --- |
| Background poll (`setInterval`) | ~1800ms when `document.visibilityState === "visible"` | Yes | Only when the server reports a changed signature and no HITL editor / half-filled batch is active |
| Top-bar refresh button | Click | No | Yes (intentional) |
| Mutation follow-up (`runAction` → `bootstrap`) | After answer / resume / retry / cancel | No | Yes (intentional) |
| Initial `bootstrap(false)` | Page load | No | Yes |

Silent means: no loading bar, and UI chrome (scroll / open details) must be
preserved across any rewrite.

## Signature-based short-circuit

`GET /api/runs/:id` accepts `?since=<signature>`. The server computes a cheap
signature from `state.revision`, `state.lastEventSequence`, and the active
job's status/detail (`runSignature` in `src/ui/server.ts`). When the query
signature matches the current one, the server returns `{unchanged:true,
signature}` with no `state`/`events`/`sessions`/`artifacts` payload — the
client does zero re-render work for that poll.

This replaced an earlier client-side approach that fetched the full payload
every poll and diffed it via `JSON.stringify(detail) === state.detailFingerprint`.
That comparison, and `state.detailFingerprint`, no longer exist. The client
now tracks `state.signature` (the last *rendered* signature) instead.

## Invariants

1. **Unchanged silent polls do not re-render the run view.**
   `loadRun` appends `?since=state.signature` whenever it is polling the same
   run it already has a signature for. A `{unchanged:true}` response returns
   immediately — no `captureScrolls`, no `renderRun`, no signature update.

2. **`state.signature` tracks the last *rendered* payload, not the last fetch.**
   If a poll skips render because a HITL editor or a half-filled batch card is
   active, do **not** advance `state.signature`. Otherwise the next poll's
   `?since=` would match the server's current signature and the client would
   stay silent forever, painting nothing even after the editor blurs.

3. **Active HITL editors and half-filled batch cards block silent re-render.**
   `preserveEditor && (editorIsActive() || batchIsActive())` skips
   `renderRun()`. `editorIsActive()` covers any focused `textarea` / `input` /
   `select` inside a `<form>` — this is what protects the reflect editor
   (wrapped in `#reflectForm`). Batch question textareas intentionally sit
   outside a `<form>` (submission is a custom multi-question payload, not a
   native form submit), so `batchIsActive()` covers them: it returns true when
   focus is anywhere inside a `[data-batch-question]` container, or when any
   question in the current batch already has a selected option, a non-empty
   free-text draft, or a skip/park mark. A batch card with several textareas
   is exactly the case a poll must never clobber mid-answer.

4. **Silent re-renders restore scroll and details chrome.**
   Before rewriting DOM, `captureScrolls()` records:
   - `window` scroll
   - every `[data-scroll-key]` node (brief body, task evidence output, …)
   - sidebar `#runList` scroll
   - every `[data-details-key]` open/closed state (including the fog
     register's `data-details-key="fog-resolved"` collapsible)
   After `renderRun()`, `restoreScrolls()` reapplies them.

5. **Sidebar list scroll survives every poll.**
   `renderSidebar()` always restores `#runList.scrollTop` after rewriting items
   (including relative "ago" labels that change without a run-detail change).

6. **Knowledge view is not clobbered by run polling.**
   The interval refreshes bootstrap/sidebar data, then loads a run only when
   `state.view === "runs"`. Knowledge search results stay put.

7. **Manual refresh and post-mutation bootstrap may reset chrome.**
   The ↻ button and `runAction` → `bootstrap(true)` are explicit operator
   actions; they reload without silent scroll restoration.

8. **The thinking-strip elapsed timer never triggers a re-render.**
   `startElapsedTimer` ticks a `setInterval` that only rewrites
   `#thinkingElapsed`'s `textContent`. It self-stops the moment that node is
   gone (tab switched away, run reloaded), and `renderOverview` always calls
   `stopElapsedTimer()` before starting a fresh one, so timers never stack.

## Scrollable / disclosure keys that must stay stable

When adding a new overflow region or `<details>` block inside poll-rewritten
DOM (`#content` / `#tabBody`), give it a stable key:

| Surface | Attribute | Example |
| --- | --- | --- |
| Confirmed / draft brief | `data-scroll-key="brief"` | Overview card |
| Task evidence output | `data-scroll-key="<taskId>-evidence-<n>"` | Tasks tab |
| Task acceptance criteria | `data-details-key="<taskId>-criteria"` | Tasks tab |
| Task evidence group | `data-details-key="<taskId>-evidence"` | Tasks tab |
| Resolved open-unknowns | `data-details-key="fog-resolved"` | Overview card |

Dialogs (artifact viewer, session inspector, settings, new run) are outside the
poll rewrite path and do not need these keys unless a future change starts
re-rendering them from the interval.

## Known acceptable staleness

- Relative timestamps ("3m ago") in the sidebar can lag by one poll while the
  selected run detail is unchanged. Prefer that over rewriting the run view.
- While a HITL editor or batch card is active, the visible run view can lag
  the latest fetched `state.detail` until the editor blurs (or the batch is
  fully answered/parked/submitted) and the next poll renders.

## Failure modes to watch for

- **Scroll jumps while idle** → signature short-circuit broken, or a field in
  `runSignature` (server) is changing every poll without a real state
  transition.
- **Scroll jumps only while a job runs** → capture/restore missing a new
  `[data-scroll-key]` region.
- **Stale UI after finishing an answer edit** → signature advanced during an
  editor-skipped poll (invariant 2).
- **Draft answer wiped** → `answerDrafts` / `selectedOptions` / `parked` not
  applied in `renderOverview`/`renderQuestionBatch`, or a re-render happened
  without `preserveEditor`.
- **A batch card gets clobbered mid-answer** → `batchIsActive()` not checked
  alongside `editorIsActive()` in `loadRun`, or a new batch interaction path
  (e.g. a future control) mutates `state.selectedOptions`/`state.parked`
  without `batchIsActive()` picking it up.

## Code map

- Poll loop: `src/ui/app.ts` (`setInterval` near bootstrap)
- Gate + restore: `loadRun`, `captureScrolls`, `restoreScrolls`,
  `editorIsActive`, `batchIsActive`
- Server-side signature: `runSignature` in `src/ui/server.ts`
- Contract tests: `tests/unit/ui-app.test.ts`,
  `tests/integration/ui.test.ts` ("reports unchanged for a matching
  ?since= signature…")
