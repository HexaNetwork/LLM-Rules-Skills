# Dashboard background refresh contract

The dashboard polls while the tab is visible so operators can watch long-running
reflect / grill / implement work without manually refreshing. Polling must never
feel like a page reload.

This document is the checklist for that contract. Keep the tests in
`tests/unit/ui-app.test.ts` aligned with it.

## Refresh sources

| Source | Interval / trigger | Silent? | May rewrite run DOM? |
| --- | --- | --- | --- |
| Background poll (`setInterval`) | ~1800ms when `document.visibilityState === "visible"` | Yes | Only when run detail changed and no HITL editor is focused |
| Top-bar refresh button | Click | No | Yes (intentional) |
| Mutation follow-up (`runAction` → `bootstrap`) | After answer / resume / retry / cancel | No | Yes (intentional) |
| Initial `bootstrap(false)` | Page load | No | Yes |

Silent means: no loading bar, and UI chrome (scroll / open details) must be
preserved across any rewrite.

## Invariants

1. **Unchanged silent polls do not re-render the run view.**
   Compare `JSON.stringify(detail)` to `state.detailFingerprint` and return
   early when equal. This is what stops the Confirmed brief (and the rest of
   the overview) from jumping every 1.8s while a run is idle.

2. **`detailFingerprint` tracks the last rendered payload, not the last fetch.**
   If a poll skips render because a HITL editor is focused, do **not** advance
   the fingerprint. Otherwise the next poll after blur can treat stale DOM as
   current and never paint the newer detail.

3. **Active HITL editors block silent re-render.**
   When `preserveEditor && editorIsActive()` (focused `textarea` / `input` /
   `select` inside a form), skip `renderRun()`. Answer text is also kept in
   `state.answerDrafts` so a later render restores the draft.

4. **Silent re-renders restore scroll and details chrome.**
   Before rewriting DOM, `captureScrolls()` records:
   - `window` scroll
   - every `[data-scroll-key]` node (brief body, task evidence output, …)
   - sidebar `#runList` scroll
   - every `[data-details-key]` open/closed state
   After `renderRun()`, `restoreScrolls()` reapplies them.

5. **Sidebar list scroll survives every poll.**
   `renderSidebar()` always restores `#runList.scrollTop` after rewriting items
   (including relative “ago” labels that change without a run-detail change).

6. **Knowledge view is not clobbered by run polling.**
   The interval refreshes bootstrap/sidebar data, then loads a run only when
   `state.view === "runs"`. Knowledge search results stay put.

7. **Manual refresh and post-mutation bootstrap may reset chrome.**
   The ↻ button and `runAction` → `bootstrap(true)` are explicit operator
   actions; they reload without silent scroll restoration.

## Scrollable / disclosure keys that must stay stable

When adding a new overflow region or `<details>` block inside poll-rewritten
DOM (`#content` / `#tabBody`), give it a stable key:

| Surface | Attribute | Example |
| --- | --- | --- |
| Confirmed / draft brief | `data-scroll-key="brief"` | Overview card |
| Task evidence output | `data-scroll-key="<taskId>-evidence-<n>"` | Tasks tab |
| Task acceptance criteria | `data-details-key="<taskId>-criteria"` | Tasks tab |
| Task evidence group | `data-details-key="<taskId>-evidence"` | Tasks tab |

Dialogs (artifact viewer, session inspector, settings, new run) are outside the
poll rewrite path and do not need these keys unless a future change starts
re-rendering them from the interval.

## Known acceptable staleness

- Relative timestamps (“3m ago”) in the sidebar can lag by one poll while the
  selected run detail is unchanged. Prefer that over rewriting the run view.
- While a HITL editor is focused, the visible run view can lag the latest
  fetched `state.detail` until the editor blurs and the next poll renders.

## Failure modes to watch for

- **Scroll jumps while idle** → fingerprint short-circuit broken, or a field in
  the run detail payload is changing every poll without a real state transition.
- **Scroll jumps only while a job runs** → capture/restore missing a new
  `[data-scroll-key]` region.
- **Stale UI after finishing an answer edit** → fingerprint advanced during an
  editor-skipped poll (invariant 2).
- **Draft answer wiped** → `answerDrafts` not applied in `renderOverview`, or
  re-render happened without `preserveEditor`.

## Code map

- Poll loop: `src/ui/app.ts` (`setInterval` near bootstrap)
- Gate + restore: `loadRun`, `captureScrolls`, `restoreScrolls`, `editorIsActive`
- Contract tests: `tests/unit/ui-app.test.ts`
