# LeaseQA Server Notes

## Canonical Docs

Backend operational truth in this repo lives in:

- `/Users/Z1nk/Desktop/proj/leaseqa/leaseqa-server/README.md`
- `/Users/Z1nk/Desktop/proj/leaseqa/leaseqa-server/.env.example`

Current product behavior and cross-repo architecture live in the client repo:

- `/Users/Z1nk/Desktop/proj/leaseqa/leaseqa-client/docs/product-prd.md`
- `/Users/Z1nk/Desktop/proj/leaseqa/leaseqa-client/docs/architecture.md`
- `/Users/Z1nk/Desktop/proj/leaseqa/leaseqa-client/docs/api-design.md`
- `/Users/Z1nk/Desktop/proj/leaseqa/leaseqa-client/docs/release-checklist.md`

## Documentation Impact Rules

When backend changes public auth, account, activity, notification, Q&A, moderation, or RAG behavior:

- review this repo's `README.md`
- review the canonical client docs listed above
- update both repos if the change affects public behavior or API contracts

Do not treat backend feature work as complete until documentation impact has been checked.

## RAG Knowledge Ingestion

- The knowledge corpus ingest job is resumable.
- Progress is stored in `/Users/Z1nk/Desktop/proj/leaseqa/leaseqa-server/.rag-knowledge-ingest-state.json` by default.
- Run `npm run ingest:rag` from `/Users/Z1nk/Desktop/proj/leaseqa/leaseqa-server` to resume from the saved checkpoint.
- Run `npm run ingest:rag:reset` from `/Users/Z1nk/Desktop/proj/leaseqa/leaseqa-server` to rebuild the knowledge collection from scratch.
- Knowledge chunk rows are written idempotently per source file. Before retrying a file, existing rows for that file are deleted and then reinserted.

## Retrieval

- Current RAG retrieval uses Milvus hybrid search: dense embedding + BM25 sparse retrieval.
- Dense and sparse results are merged with RRF reranking.
- Citations are attached from the retrieved chunks, not from a post-hoc attribution pass over the model output.

## Gemini Chat

- Backend chat now defaults to Gemini through the OpenAI-compatible Gemini endpoint.
- Default chat model is `gemini-2.5-pro`.
- Preferred env vars for chat are:
  - `GEMINI_CHAT_API_KEY`
  - `GEMINI_CHAT_MODEL`
  - `GEMINI_CHAT_BASE_URL`
- RAG still honors `RAG_CHAT_*` as the highest-precedence override layer.

## RAG Testing

- Run `npm run test:rag` from `/Users/Z1nk/Desktop/proj/leaseqa/leaseqa-server` for RAG unit tests.
- Run `npm run eval:rag:smoke` from `/Users/Z1nk/Desktop/proj/leaseqa/leaseqa-server` for a small live retrieval eval against the running backend.
- Run `npm run eval:rag` from `/Users/Z1nk/Desktop/proj/leaseqa/leaseqa-server` for the full live eval set.
- Eval cases live in `/Users/Z1nk/Desktop/proj/leaseqa/leaseqa-server/LeaseQA/RAG/evals/tenant-rights-eval.json`.
