# RAG Corpus Upstream Sync Design

**Date:** 2026-08-23
**Status:** Approved (route and eval-gate decisions confirmed by the project owner)

## Problem

The knowledge corpus is a static snapshot of MassLegalHelp's *Legal Tactics: Tenants'
Rights in Massachusetts* (2025 edition, 81 PDFs). It was downloaded 2026-03-01/02 and
last ingested 2026-08-20 (`corpusVersion=fc79c9e2…`). Nothing in the repository detects
or reacts to upstream changes: there is no cron, no scheduler, and no `schedule:`-triggered
workflow. `server/.github/workflows/rag-live-eval.yml` is `workflow_dispatch` only.

For a tenant-rights answering product used in UPL research, serving a silently stale
2025 edition is a correctness and credibility problem.

## What already works (do not rebuild)

`ingestKnowledgeCorpus()` in `server/LeaseQA/RAG/service.js` is already content-addressed
and blue/green:

- `corpusVersion = sha256(manifest text + sorted per-PDF sha256 + embedding fingerprint)`
- writes to versioned collection `leaseqa_knowledge_chunks_<version12>`
- atomically repoints the alias when complete; unchanged content is a full no-op
- resumable via `nextIndex`; old collections cleaned up after activation
- reconstructs lost state from the live Milvus alias target

Re-ingest is therefore safe and idempotent. The gaps are upstream of it (change
detection, provenance) and downstream of it (quality gate).

## Gaps

1. **No upstream change detection.** `source_url` is a chapter page URL for citation, not a
   PDF link. There is no `pdf_url`, `content_sha256`, `retrieved_at`, or machine-readable
   upstream revision; the official revision string (e.g. `"01 Moving 2025 Updated 8-13-25"`)
   only exists as free text inside `title_hint`.
2. **Corpus is unversioned.** The workspace root repository has zero commits and the server
   repository does not track `resources/`. CI cannot ingest, and there is no history to diff
   or roll back.
3. **Alias activation has no quality gate.** `service.js` calls `activateCollectionAlias`
   unconditionally after the last chunk. `npm run eval:rag` can only run after production
   traffic has already moved to the new collection.
4. **Corpus provenance is invisible to users.** No surfaced edition or retrieval date.
   (Out of scope for this plan; tracked separately.)

## Upstream access constraint

masslegalhelp.org sits behind Cloudflare. Verified 2026-08-23:

- plain `curl`, and `curl` with a desktop browser UA, both return `403` with
  `cf-mitigated: challenge`
- `/sitemap.xml` is challenged the same way
- `/robots.txt` returns 200 and is stock Drupal — it does **not** disallow the
  `housing-apartments-shelter/tenants-rights` content paths

**Rule:** no code in this project may attempt to defeat, solve, or evade the bot check.
A real browser (Playwright, default Chromium, desktop viewport) may load public content
pages at a polite rate. If a page still returns a challenge, the checker records it as
`blocked` and defers to a human. It never retries in a loop.

## Chosen route

**Change detection + human retrieval + automated ingest.** Automation observes and
reports; a human performs the actual download in a real browser; automation then verifies,
re-hashes, and ingests behind a quality gate.

Rejected: fully automated scraping (fragile against Cloudflare, and periodic bulk
retrieval from a legal-aid nonprofit needs their consent first). Deferred: asking
MassLegalHelp for a feed or allowlist — worth doing in parallel, does not block this work.

## Design decisions

### D1 — Manifest columns must be content-stable

`corpusVersion` hashes the manifest's full text. Any column that changes without the PDF
bytes changing would force a pointless full re-ingest (81 files, all embeddings).

Therefore:

- **In `corpus_manifest.csv`** (append-only, changes only when content changes):
  `pdf_url`, `content_sha256`, `retrieved_at`, `upstream_revision`
- **In a separate `upstream_state.json`** (volatile check bookkeeping, never hashed
  because it is not a manifest row): `checkedAt`, and per file `pdfUrl`, `revision`,
  `status`, `pageUrl`

`refresh-corpus-manifest.js` updates `retrieved_at` **only when `content_sha256` actually
changes**, and promotes a newly discovered `pdf_url`/`upstream_revision` from
`upstream_state.json` into the manifest **only during a real content refresh**. A refresh
that finds nothing new must leave `corpus_manifest.csv` byte-identical.

`parseCorpusManifest` is header-driven and `buildKnowledgeChunkRows` cherry-picks known
fields, so appending columns is backward compatible with no parser change.

### D2 — Corpus lives in its own repository, wired via `RAG_CORPUS_ROOT`

36 MB total, largest file 1.5 MB — plain git, **no git-lfs** (which is not installed here
and is not needed below GitHub's 50 MB per-file warning).

A separate `leaseqa-corpus` repository rather than a directory in the server repository,
because:

- only `ingestKnowledgeCorpus` reads the corpus; the running web service never touches it,
  so shipping 36 MB to Render on every deploy is dead weight
- corpus refresh commits would otherwise trigger a production web-service deploy
- `config.js` already honours `RAG_CORPUS_ROOT`, so CI just checks out both repositories
  and sets one env var — no submodule, no code change to `resolveCorpusRoot()`

Local development is unaffected: the workspace `resources/rag-corpus/` directory becomes a
clone of that repository and the existing parent-directory walk still finds it.

### D3 — The gate is retrieval-only and runs in-process

`scripts/run-rag-eval.js` evaluates over HTTP against a running server, so it cannot gate
an ingest that has not swapped the alias yet.

The gate instead queries the **staging** collection directly and checks retrieval, with no
LLM call and no HTTP server. It reuses `LeaseQA/RAG/evals/tenant-rights-eval.json`, whose
cases already carry `expectedSourceGroup`, `expectedChapterRefs`, and
`expectedSourceNameIncludes` — exactly the metadata Milvus returns.

- 27 of 28 cases are checkable this way. The single `expectAbstain` case is skipped:
  abstention is a generation decision, not a retrieval one.
- Gate passes when hit rate ≥ `RAG_INGEST_GATE_MIN_HIT_RATE` (default `0.9`).
- On failure the run stays `status: "staging"`, the alias is **not** moved, the staging
  collection is left intact for inspection, and the process exits non-zero.

This catches the regression a corpus swap actually causes — the right chapter no longer
being retrievable. Generation-quality regressions remain the job of the existing
`workflow_dispatch` live eval, which can now target a staging collection via
`RAG_MILVUS_KNOWLEDGE_COLLECTION` before activation.

`matchesExpectation` currently lives inside `run-rag-eval.js` and operates on camelCase
citations; the gate needs the same rule over snake_case Milvus rows. Extract it once into
`LeaseQA/RAG/evalExpectations.js` and have both callers normalize into it.

### D4 — No circular imports

`service.js` will import the gate, so the gate must not import `service.js`. The gate
receives `embedQuery` and `retrieveChunks` as injected dependencies, matching the
`dependencies` object convention already used throughout `service.js`.

## Non-goals

- Surfacing corpus edition/date in the client UI (separate plan)
- Expanding the corpus beyond Massachusetts
- Any change to chunking, embedding provider, or retrieval ranking
