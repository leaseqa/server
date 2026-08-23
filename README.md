# LeaseQA Server

This repository contains the Express API and RAG services used by the LeaseQA web client.

Canonical product docs live in the client repo:

- Product PRD: [leaseqa-client/docs/product-prd.md](/Users/Z1nk/Desktop/proj/leaseqa/leaseqa-client/docs/product-prd.md)
-
Architecture: [leaseqa-client/docs/architecture.md](/Users/Z1nk/Desktop/proj/leaseqa/leaseqa-client/docs/architecture.md)
- API design
  summary: [leaseqa-client/docs/api-design.md](/Users/Z1nk/Desktop/proj/leaseqa/leaseqa-client/docs/api-design.md)
- Release
  checklist: [leaseqa-client/docs/release-checklist.md](/Users/Z1nk/Desktop/proj/leaseqa/leaseqa-client/docs/release-checklist.md)

Production:

- API base: [https://leaseqa-server.onrender.com](https://leaseqa-server.onrender.com)
- Health check: [https://leaseqa-server.onrender.com/api/health](https://leaseqa-server.onrender.com/api/health)

## What this server provides

- Session-based auth with tenant, lawyer, and admin roles
- REST endpoints for users, posts, answers, follow-up discussions, folders, moderation, stats, and activity
- RAG chat sessions under `/api/rag/*` for pasted text, PDF uploads, and DOCX uploads
- Mongo-backed app data and sessions
- Citation-aware answers that can return both uploaded-source evidence and supporting handbook evidence
- Account activity feed events and unread notification entries

## RAG Grounding Model

The RAG layer combines:

- uploaded user material: pasted clause text, uploaded `PDF`, or uploaded `DOCX`
- ingested housing-rights reference material from the MassLegalHelp corpus committed at `resources/rag-corpus/mass tenant rights` (override with `RAG_CORPUS_ROOT`)

The ingested knowledge base is organized around:

- handbook chapters
- handouts
- forms
- booklets

Knowledge retrieval is stored in Milvus / Zilliz collections and answer generation is driven through the configured chat
model endpoints.

## Activity and Notification Model

The server writes user-facing activity events for:

- AI review creation
- post creation
- post status changes
- inbound answers
- inbound discussion replies

These are exposed through:

- `GET /api/activity`
- `GET /api/activity/notifications`
- `POST /api/activity/notifications/read`

## Key Infrastructure

- Express
- MongoDB Atlas
- `npm`
- Milvus / Zilliz for vector search
- Alibaba Cloud DashScope (百炼) OpenAI-compatible chat (`qwen-plus`) and embeddings (`text-embedding-v3`, 1024-d)
- Render for production hosting

## Local Development

Requirements:

- Node `24.x` (Node 26 is covered as a compatibility CI lane)
- `npm`

Setup:

```bash
cp .env.example .env
npm ci
npm run dev
```

Default local server:

- `http://localhost:4050`

Expected local client:

- `http://localhost:3000`

## Important Environment Variables

- `DATABASE_CONNECTION_STRING`
- `CLIENT_URL`
- `SESSION_SECRET`
- `RAG_CORPUS_ROOT` (optional; only needed when the corpus is not the committed in-repository copy)
- `RAG_MILVUS_ADDRESS`
- `RAG_MILVUS_TOKEN`
- `RAG_MILVUS_KNOWLEDGE_COLLECTION`
- `RAG_MILVUS_SESSION_COLLECTION`
- `RAG_CORPUS_MANIFEST` (optional; defaults to `corpus_manifest.csv` under the corpus root)
- `RAG_INGEST_STATE_PATH` (optional; defaults to `.rag-knowledge-ingest-state.json`)
- `RAG_EVAL_MIN_PASS_RATE` (committed default `0.90`)
- `RAG_EVAL_MIN_SAFE_RATE` (committed default `0.98`)
- `RAG_EVAL_OUTPUT` (optional JSON artifact path)
- `DASHSCOPE_API_KEY` (Alibaba Cloud Model Studio / 百炼; used for both chat and embedding)
- `RAG_CHAT_*` (defaults: `qwen-plus` at `https://dashscope.aliyuncs.com/compatible-mode/v1`)
- `RAG_EMBEDDING_*` (defaults: OpenAI-compatible `text-embedding-v3`, 1024 dimensions)
- `GEMINI_API_KEY` / `GEMINI_CHAT_*` (optional override; set `RAG_EMBEDDING_PROVIDER=gemini` to restore Gemini `embedContent`)

See [.env.example](/Users/Z1nk/Desktop/proj/leaseqa/leaseqa-server/.env.example) for the full template.

## Useful Commands

```bash
npm run dev
npm start
npm run test:rag
npm run eval:rag:smoke
npm run ingest:rag
npm run ingest:rag:reset
npm run seed:demo-users
```

## RAG lifecycle operations

Delete a RAG session and its uploaded-source vectors with:

```text
DELETE /api/rag/sessions/:sessionId
```

The caller must own the authenticated session or present the same guest browser session. Deletion always attempts Milvus first and Mongo second. A `503 RAG_SESSION_DELETE_RETRYABLE` response means at least one store did not complete; retrying is safe. Mongo session records and guest RAG metadata expire after 30 days.

Knowledge ingestion is content-addressed and resumable:

```bash
npm run ingest:rag
npm run ingest:rag -- --limit=5
npm run ingest:rag:reset
RAG_CORPUS_ROOT=/absolute/path/to/mass\ tenant\ rights npm run ingest:rag
```

### Knowledge corpus

The corpus is committed in this repository at `resources/rag-corpus/mass tenant rights` (81 PDFs, 36 MB, plain git, no LFS). Only `npm run ingest:rag` reads it; the running web service never does. Two consequences of co-locating it, accepted deliberately because corpus updates are infrequent: deploys pull 36 MB they will not use, and a corpus-only commit triggers a web-service deploy.

`resolveCorpusRoot()` checks this repository first and only then walks up to parent directories, so the committed corpus is never shadowed by a stale copy outside it. `RAG_CORPUS_ROOT` overrides both and is how to point the ingest at any other layout — a mounted volume, a separate checkout, or a deployed environment where the corpus lives elsewhere. The resolved path is never persisted in production configuration; only the runtime manifest path appears in the local ingest-state file.

A pre-migration copy of this corpus may still exist outside the repository at `<workspace>/resources/rag-corpus` on the original development machine. It is redundant and is **not** the corpus these commands operate on. Run every command below from this repository root; if `npm run corpus:refresh -- --dry-run` reports a `corpusRoot` outside this checkout, stop — you are about to rewrite the wrong manifest.

Refresh procedure, all commands from this repository root:

1. `npm run corpus:check -- --write-state` and read the report. It never downloads and never attempts to defeat the upstream bot check.
2. Download each changed PDF **in a real browser** from the page URL in the report, overwriting the file in place under its existing name.
3. `npm run corpus:refresh -- --dry-run` to preview, then `npm run corpus:refresh` to write. The `--` separator is required: `npm run corpus:refresh --dry-run` forwards nothing to the script and performs a **real write**. Only rows whose bytes changed are rewritten, so a no-op refresh leaves `corpus_manifest.csv` byte-identical and does not trigger a re-ingest. The previous manifest is kept as the single `corpus_manifest.csv.bak`.
4. Commit the changed PDFs, `corpus_manifest.csv`, `corpus_manifest.csv.bak` and `upstream_state.json` together.
5. Ingest: run the `corpus-ingest` workflow (`workflow_dispatch`; `min_hit_rate` defaults to `0.9`) or `npm run ingest:rag` locally. The retrieval gate decides whether the alias moves.

Step 1 also runs on its own: the `corpus-upstream-check` workflow crawls the eight index pages every Monday at 13:00 UTC (and on `workflow_dispatch`), uploads the JSON report as an artifact, and opens — or comments on, if one is already open — a single issue labelled `corpus-upstream`. It files on two different outcomes and says which: the checker's exit 3, MassLegalHelp published changes, and exit 4, the run could not confirm every row because a page was blocked or a manifest row matched no PDF. An inconclusive run is never reported as a clean one, which is the whole reason exit 4 exists. Exit 1, a broken checker, fails the run instead of filing anything. The workflow never downloads a PDF and never retries a bot challenge.

The `corpus-ingest` workflow requires an explicit target alias and refuses to start without one, because the retrieval gate queries the staging collection and therefore cannot detect an ingest that repoints the wrong alias. Supply it as the `knowledge_alias` dispatch input, or once as the `RAG_EVAL_MILVUS_KNOWLEDGE_COLLECTION` secret. It must match the `RAG_MILVUS_KNOWLEDGE_COLLECTION` the readers are deployed with.

A failed gate exits 2, leaves the alias where it was, and leaves the staging collection in place to be inspected. Retrying it in CI is not free by default: the ingest state lives under the run's own workspace, which is empty on a fresh run, so a plain retry cannot see the staging collection, drops it, and re-embeds all 81 files. Pass the failed run's id as the `resume_from_run_id` dispatch input; the workflow restores that run's `corpus-ingest-<run id>` artifact first, and the retry re-runs the gate against the collection that is already there. The restore is best-effort: a wrong id, or an artifact past the repository's retention window, logs a warning and the run proceeds as a full re-ingest, so read the staging collection before retrying rather than after.

See `resources/rag-corpus/mass tenant rights/CORPUS_GUIDE.md` and `docs/superpowers/specs/2026-08-23-corpus-upstream-sync.md`.

Each ingest computes `sha256(manifest bytes + sorted source hashes + embedding provider/model/dimension)`, writes to `leaseqa_knowledge_chunks_<version-prefix>`, flushes and loads the complete staging collection, then atomically moves the stable alias configured by `RAG_MILVUS_KNOWLEDGE_COLLECTION`. Old versioned collections are removed only after activation. `--limit` leaves staging state without activating a partial corpus; a later run resumes it. `--reset` restarts only the current staging version and does not delete the active alias target.

Switching embedding vendor or dimension (for example Gemini `gemini-embedding-001` at 768-d to DashScope `text-embedding-v3` at 1024-d) produces a new corpus version automatically. Existing Gemini collections cannot serve DashScope vectors; run `npm run ingest:rag` after changing provider config. Session collections use a stable name (`RAG_MILVUS_SESSION_COLLECTION`); drop or recreate that collection after a dimension change, because new session uploads will not fit a 768-d schema.

For deployments where `RAG_MILVUS_KNOWLEDGE_COLLECTION` is still a physical legacy collection, migrate without overwriting it:

1. Set `RAG_MILVUS_KNOWLEDGE_COLLECTION` to a new unused stable alias, for example `leaseqa_knowledge`.
2. Run `npm run ingest:rag` and verify the emitted `corpusVersion`, `collectionName`, and `alias` JSON.
3. Deploy readers with the same alias setting.
4. Remove the legacy physical collection only after the new alias has served verified queries.

Run the deterministic contract/evaluation layer locally with no provider credentials:

```bash
npm run test:rag
node scripts/run-rag-eval.js --help
```

The credentialed runner targets a live server and always writes a JSON artifact containing per-case latency, source matching, citation validity, abstention, content safety, and the aggregate pass/safe rates:

```bash
RAG_EVAL_BASE_URL=http://127.0.0.1:4050 \
RAG_EVAL_OUTPUT=artifacts/rag-eval.json \
npm run eval:rag
```

It exits `1` below pass rate `0.90` or safe rate `0.98`. GitHub's manually dispatched `Live RAG Evaluation` workflow requires its dedicated Mongo, DashScope (`RAG_EVAL_DASHSCOPE_API_KEY`), session-secret, and Milvus secrets and uploads the artifact even when the gate fails. `RAG_EVAL_GEMINI_API_KEY` remains an optional Gemini override.

## Verification Used for the Current Release

- `npm run test:rag`
-
`node --test LeaseQA/Activity/routes.test.js LeaseQA/Auth/routes.test.js LeaseQA/Answers/routes.test.js LeaseQA/Discussions/routes.test.js LeaseQA/Posts/routes.test.js LeaseQA/RAG/sessionBootstrap.test.js`
- production `/api/health`
