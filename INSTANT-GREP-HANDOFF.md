# Instant grep handoff (PR 2 slice)

Baseline before this slice: `ddbd0d7`. Node scanner + compact index update:
`ab4eb34` + this change.

## Implemented

- Persistent Bloom trigram index: `.harness/index/trigram-v2.json`.
  Each file stores `mtimeMs`, `size` and a 512-byte Bloom filter over
  ASCII-folded byte trigrams. No per-file trigram arrays, no postings map.
- Literal queries with >=3 chars use the Bloom prefilter → candidate files →
  `rg` (if present) or the new Node scanner confirms current content.
- No false negatives: the Bloom filter only over-selects; confirmation always
  rescans bytes. Files >128 KB are stored without a filter and scanned as
  candidates.
- Index is incremental by `mtimeMs` + `size`; added/changed/deleted files are
  detected, unchanged files are not re-read.
- Cache is workspace-scoped and versioned. Corrupt/missing/cold/partial cache
  falls back to full scan. A partial (timed-out) build never prunes entries.
- Scope is applied before scanning candidates. `.git`, `.harness`, node_modules,
  binaries, secrets, >512 KB files and symlink escapes stay excluded.
- `preparePattern` skips the full tree walk when the index is complete; it
  filters candidates by scope instead.
- Patch/rollback delete both BM25 and Bloom caches.
- `--index` reports BM25 + trigram stats.
- Result metadata: `data.index.used`, `files`, `candidates`, `updated`,
  `durationMs`, or `fallback`.
- Regex and <3-char queries intentionally skip the index. Unicode
  case-insensitive literal queries also skip it because the Bloom filter folds
  ASCII only.

## Node scanner (no ripgrep required)

- Literal: `Buffer.indexOf` on raw bytes for case-sensitive; one ASCII fold
  (`latin1` round-trip) per file for case-insensitive. No `split('\n')`, no
  per-line `toLowerCase`, no per-file `realpathSync`.
- One hit per matching line, matching `rg`/legacy behaviour; `matchCount`
  counts every occurrence on that line.
- Column is a UTF-8 byte offset converted to JS string units only when the
  line prefix contains non-ASCII bytes.
- Regex: whole-file `gm` scan, cross-line matches rejected to preserve the
  old line-by-line semantics.
- Unicode case-insensitive literals and literals containing `\n`/`\r` use the
  legacy line scanner for exact semantics.
- Group/batch literal search shares the same byte scanner and folds each file
  once for all queries.

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

`test/fast-scan.js`:

- literal hit lines, no duplicate line hits
- `matchCount`, `matchText`, three-line snippet
- Unicode column parity
- CRLF line handling
- case-sensitive vs case-insensitive
- Vietnamese case-insensitive fallback
- regex line semantics (`^`, no cross-line match)
- limit/truncation, binary/large-file exclusion
- indexed vs full-scan parity, scope without full walk
- deterministic fuzz corpus: indexed results must be a subset of real hits and
  must equal the full scan when neither side truncates

Observed fixture (2,000 files × 100 lines, ~8 MB):

```text
cold index build  91ms   index 1.5MB
fresh load+search 34ms   (old: 73ms, index 9.2MB)
rare query        18ms
warm query        26ms
full Node scan    39ms   (old: 76ms)
group 3 queries   41ms   (old: 88ms)
```

Small fixture: `instant grep p50=6ms indexBytes=3157`.

## Limits

- This is a literal trigram prefilter, not semantic/vector search.
- Bloom false positives cause extra file scans, never missed hits.
- Regex uses the existing `rg`/Node path; no regex prefilter is attempted.
- Very broad trigrams (>2000 candidate files) fall back to a normal scan.
- The index still walks + stats the tree on each query to detect changes.
- Live large-repo benchmarking is still needed before changing defaults.
