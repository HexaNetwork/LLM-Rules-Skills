# Duplication grep seeds

Run these (adjust paths to scope). A hit is a **lead**, not proof — read both sides.

## API / HTTP (high priority)

Per `api-service-deduplication.mdc`, search `src/**/services/**` and `src/lib/http/**`:

```
pagination|pageSize|perPage|per_page
URLSearchParams
unwrap|envelope|\.data\b
Map<string,\s*Promise
bookmark|engagement|likeStory
coalesce|inFlight|in-flight
buildQuery|queryParams
```

Compare any feature-local helper to `src/lib/http` before reporting.

## React hooks

```
useEffect\(\(\)\s*=>\s*\{
useState<.*>\(\[\]\)
useCallback\(
useMemo\(
```

Look for hooks in the same feature with the same dependency arrays and fetch/save sequences.

## Components (UI)

Filename globs (Glob tool):

- `**/*Modal*.tsx`
- `**/*Picker*.tsx`
- `**/*Panel*.tsx`
- `**/*Form*.tsx`
- `**/*List*.tsx`

Within a cluster, diff props and JSX structure — near-duplicates often differ only in copy, icon, or one field.

## Strings and i18n

Repeated user-visible English in TSX (not in `src/i18n/`) may indicate duplicate UI flows — lower priority than logic duplication.

## False positives (do not report as duplication)

- Same **type** shape, different **domain** meaning (separate DTOs per OpenAPI)
- Router/layout shells that must stay parallel
- Generated or barrel `index.ts` re-exports
- Vitest `describe` / `beforeEach` scaffolding
- Tailwind class strings that match by coincidence

## Intentional parallelism

Tag **intentional** when ADR, comment, or product requires separate code paths (e.g. public vs authenticated API client). Offer ADR only if the user wants to record the reason.
