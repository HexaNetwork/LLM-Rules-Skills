# Code duplication scan

**Scope:** [paths, extensions, date]
**Scanned by:** find-code-duplication skill

## Summary

| Priority | Clusters | Est. lines recoverable |
|----------|----------|------------------------|
| High     |          |                        |
| Medium   |          |                        |
| Low      |          |                        |

One paragraph: where duplication is concentrated (e.g. `services/`, landing-designer modals).

---

## Clusters

### 1. [Short title]

| | |
|--|--|
| **Priority** | high / medium / low |
| **Type** | extract util / shared hook / shared component / coincidental / intentional |
| **Locations** | `path:a–b`, `path:c–d` |
| **Evidence** | jscpd clone #N / grep / semantic |
| **Similarity** | What matches (logic, structure, props) |
| **Difference** | What must stay separate |
| **Suggestion** | Target module or Kitchen Sink section; do not merge if OpenAPI shapes differ |
| **Test surface** | Public API to characterize before refactor (existing test files, or "none — needs render test") |
| **Risk** | Low / medium — coupling, wrong abstraction |

Repeat for each cluster.

---

## Pattern grep notes

Bullet list of interesting grep leads that did not become full clusters.

---

## Excluded / intentional

Items reviewed and rejected (with one-line reason each).

---

## Next step

Which clusters should we consolidate? (numbers or "none")

Consolidation uses the **`tdd` skill**: characterization tests for each cluster **before** any extract or delete (red → green → refactor, vertical slices).
