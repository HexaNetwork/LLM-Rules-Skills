---
name: grill-me
description: Interview the user relentlessly about a plan or design until reaching shared understanding, resolving each branch of the decision tree. Creates GLOSSARY.md and ADRs as terms and decisions crystallise. Use when the user wants to stress-test a plan, get grilled on their design, or mentions "grill me".
disable-model-invocation: true
---

# Grill-Me

Interview the user relentlessly about every aspect of the plan or design until reaching shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

Ask questions one at a time.

If a question can be answered by exploring the codebase, explore the codebase instead.

## Domain language

Use the `/domain-modeling` skill throughout the session. Domain vocabulary lives in `GLOSSARY.md` — read it at the start, challenge conflicts inline, and update it the moment a term is resolved. Record load-bearing trade-offs as ADRs in `docs/adr/`.
