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
- Volcengine Ark Agent Plan, OpenAI-compatible chat (`doubao-seed-2.0-lite`) and
  embeddings (`doubao-embedding-vision`, 1024-d) — the provider this deployment is configured with
- Alibaba Cloud DashScope (百炼) as the alternate plug (`qwen-plus`, `text-embedding-v3`, 1024-d).
  It is also what the code falls back to when `RAG_PROVIDER` is unset, which is why that
  variable has to be set explicitly rather than left to the default
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
- `RAG_PROVIDER` — `ark` or `dashscope`. **Set it explicitly.** Left unset, `resolveRagProviderId()`
  infers `dashscope` unless a configured base URL contains `volces.com`, so an Ark deployment
  that supplies only `ARK_API_KEY` resolves to the DashScope preset and its models.
- `ARK_API_KEY` (Volcengine Ark Agent Plan; serves both chat and embedding under `RAG_PROVIDER=ark`.
  Defaults `doubao-seed-2.0-lite` and `doubao-embedding-vision`)
- `DASHSCOPE_API_KEY` (Alibaba Cloud Model Studio / 百炼; the equivalent under
  `RAG_PROVIDER=dashscope`. Defaults `qwen-plus` and `text-embedding-v3`)
- `RAG_CHAT_*` / `RAG_EMBEDDING_*` (per-field overrides. Each falls back to the selected
  provider's preset, so leave them unset unless pointing at a third OpenAI-compatible endpoint)

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

## Streaming answers

`POST /api/rag/sessions` and `POST /api/rag/sessions/:sessionId/messages` stream server-sent events when the request
sends `Accept: text/event-stream`, and answer with the usual JSON envelope otherwise; the eval runner relies on that.
The event format is documented once, in the client repo's `docs/api-design.md` ("Streaming the two model calls").

How the server produces it:

- `utils/eventStream.js` opens the stream on the first event, so a failure before any progress keeps its own HTTP
  status and JSON body. It saves the browser session before opening, since express-session would otherwise store a
  new guest's session only when the stream ends.
- The model is always called with streaming, JSON callers included. `RAG/answerDraft.js` reads the summary and bullet
  text out of the model's partial JSON and turns it into `delta` events.
- A transient model failure is retried until part of the draft has reached the client; after that the request fails
  instead, because a fresh attempt would not match what the client shows. JSON callers keep their retries.
- A client that disconnects stops receiving events, but the answer is still generated and stored.

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

The gate is retrieval-only by design — it proves the right chapter is still reachable, not that the answer built from it is good. To judge generation quality before the alias moves, run the `Live RAG Evaluation` workflow with its `knowledge_collection` input set to the staging collection the ingest reported (`leaseqa_knowledge_chunks_<version-prefix>`). Left blank it evaluates whatever `RAG_EVAL_MILVUS_KNOWLEDGE_COLLECTION` names, which is normally the live alias.

See `resources/rag-corpus/mass tenant rights/CORPUS_GUIDE.md`.

Each ingest computes `sha256(manifest bytes + sorted source hashes + embedding provider/model/dimension)`, writes to `leaseqa_knowledge_chunks_<version-prefix>`, flushes and loads the complete staging collection, then atomically moves the stable alias configured by `RAG_MILVUS_KNOWLEDGE_COLLECTION`. Old versioned collections are removed only after activation. `--limit` leaves staging state without activating a partial corpus; a later run resumes it. `--reset` restarts only the current staging version and does not delete the active alias target.

Switching embedding vendor or dimension (for example DashScope `text-embedding-v3` to Ark `doubao-embedding-vision`, or a 768-d to 1024-d model) produces a new corpus version automatically. Nothing verifies this at read time: `answerQuestion()` embeds the question with whatever provider the running process resolved and searches the `RAG_MILVUS_KNOWLEDGE_COLLECTION` alias directly, without comparing that provider against the one that built the collection. A dimension change is caught by Milvus, but DashScope `text-embedding-v3` and Ark `doubao-embedding-vision` are both 1024-d, so switching between those two without re-ingesting raises no error — the query vector simply lands in the wrong space, scores fall under `RAG_MIN_SUPPORT_SCORE`, and the symptom is unexplained abstention rather than a failure. Run `npm run ingest:rag` after changing provider config, and keep readers and the last ingest on the same provider. Session collections use a stable name (`RAG_MILVUS_SESSION_COLLECTION`); drop or recreate that collection after a dimension change, because new session uploads will not fit an old schema.

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

It exits `1` below pass rate `0.90` or safe rate `0.98`. GitHub's manually dispatched `Live RAG Evaluation` workflow requires its dedicated Mongo, OpenAI-compatible provider (`RAG_EVAL_PROVIDER_API_KEY`), session-secret, and Milvus secrets and uploads the artifact even when the gate fails.

The two rates measure different things:

- A case is **safe** when its answer cannot mislead a renter: no forbidden content, an out-of-scope question abstains, and every answer either cites well-formed evidence or abstains.
- A case **passes** when it is safe and its answer also cites the source the case names; an out-of-scope case passes by abstaining.

Citing another passage than the one a case names is a quality miss, not a safety failure: the model may pick a different, legally adequate source. It lowers the pass rate only, and `0.90` lets one case in ten miss. `0.98` fails the run on a single unsafe answer as long as the set has fewer than 50 cases. Each case's log line ends in `safe=`, so a red run names the case that broke it.

## Verification Used for the Current Release

- `npm run test:rag`
-
`node --test LeaseQA/Activity/routes.test.js LeaseQA/Auth/routes.test.js LeaseQA/Answers/routes.test.js LeaseQA/Discussions/routes.test.js LeaseQA/Posts/routes.test.js LeaseQA/RAG/sessionBootstrap.test.js`
- production `/api/health`
