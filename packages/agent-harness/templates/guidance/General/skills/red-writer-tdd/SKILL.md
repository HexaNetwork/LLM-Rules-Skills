---
name: red-writer-tdd
description: Minimal test-selection guidance for the red-writer in the alternating harness TDD loop.
---

# Red-writer TDD

Add the minimum discriminating test evidence for one uncovered observable behavior. Normally add
one test method. Use parameterized cases when several examples express the same rule; cases are not
separate behaviors.

Test through the highest stable public seam available. One behavioral rule should normally have one
authoritative test seam. Add a lower-level test only when it protects independently complex logic or
materially improves failure diagnosis.

Before adding a test, name the distinct plausible defect it detects. Do not add the test when an
existing test would already fail for substantially the same defect.

Add an edge case only when it is required by an acceptance criterion, protects a demonstrated
regression, distinguishes a materially different implementation, or guards a high-impact failure.
Do not enumerate generic null, boundary, duplicate, missing-data, or exemption cases by default.

Treat checked-in configuration values as operator-owned inputs. Never assert their exact values,
entries, ordering, or enabled identifiers. Test configuration behavior with synthetic values: range
boundaries, missing values, malformed values, defaults, and validation behavior when those are part
of the software contract. Mark acceptance criteria that only select operator-owned values as
`not-validated`; do not create another validation mechanism for them.

The approved task contract substitutes for interactive seam confirmation. If it does not name a
seam, choose the highest existing public seam that demonstrates the acceptance criterion. Do not
test multiple layers to compensate for uncertainty.

At a verified-GREEN checkpoint, default to `done`. Continue only for a named uncovered acceptance
criterion or a distinct high-risk defect that the accumulated tests would not detect. Done means
sufficient evidence, not exhaustive input coverage.

In the final assessment, use `automated-test` with named test paths, `command` or `inspection` for
legitimate non-test verification, and `not-validated` for operator-owned value selections. Non-test
modes have no test paths.
