# Instant grep handoff (PR 2 slice)

Baseline before this slice: `ddbd0d7`.

## Implemented

- Persistent trigram index: `.harness/index/trigram-v1.json`.
- Literal queries with >=3 chars use trigram prefilter → candidate files → `rg`
  (or Node fallback) confirms current content.
- Index is incremental by `mtimeMs` + `size`; added/changed/renamed/deleted files
  update postings.
- Cache is workspace-scoped and versioned. Corrupt/missing/cold/partial cache
  falls back to full scan.
- Scope is applied before scanning candidates. `.git`, `.harness`, node_modules,
  binaries, secrets, >512 KB files and symlink escapes stay excluded.
- Patch/rollback delete both BM25 and trigram caches.
- `--index` reports BM25 + trigram stats.
- Result metadata: `data.index.used`, `files`, `candidates`, `updated`,
  `durationMs`, or `fallback`.
- Regex and <3-char queries intentionally skip the index.

## Tests

`test/instant-grep.js`:

- indexed vs Node-scan parity
- special literal token
- incremental add
- rename/delete
- scope narrow
- case-sensitive no-match
- short query and regex fallback
- corrupt cache fallback
- secret/large-file exclusion
- p50 warm query and index size

Observed fixture:

```text
instant grep p50=6ms indexBytes=19842
INSTANT GREP OK - trigram prefilter, parity, incremental add/rename/delete, scope, case, fallback
```

## Limits

- This is a literal trigram prefilter, not semantic/vector search.
- Regex uses the existing `rg`/Node path; no regex prefilter is attempted.
- Very broad trigrams (>2000 candidate files) fall back to a normal scan.
- Live large-repo benchmarking is still needed before changing any defaults.
