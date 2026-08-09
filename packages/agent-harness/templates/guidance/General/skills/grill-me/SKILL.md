---
name: grill-me
description: Interview the user relentlessly about a plan until shared understanding, one question at a time with recommendations. Look up codebase facts; decisions belong to the user. Do not enact until confirmed. Creates GLOSSARY.md and ADRs as terms and decisions crystallise. Use when the user wants to stress-test a plan, get grilled on their design, or mentions "grill me".
disable-model-invocation: true
---

# Grill-Me

Interview the user relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

Ask the questions one at a time, waiting for feedback on each question before continuing. Asking multiple questions at once is bewildering.

If a fact can be found by exploring the codebase, look it up rather than asking the user. The decisions, though, are theirs — put each one to them and wait for their answer.

Do not enact the plan until the user confirms we have reached a shared understanding.

## Domain language

Use the `/domain-modeling` skill throughout the session. Domain vocabulary lives in `GLOSSARY.md` — read it at the start, challenge conflicts inline, and update it the moment a term is resolved. Record load-bearing trade-offs as ADRs in `docs/adr/`.
