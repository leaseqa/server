# LeaseQA Server

This repository contains the Express API and RAG services used by the LeaseQA web client.

Product overview and current user-facing features live in the client README:
- https://github.com/leaseqa/client/blob/main/README.md

Production:
- API base: https://leaseqa-server.onrender.com
- Health check: https://leaseqa-server.onrender.com/api/health

## What this server provides

- Session-based auth with tenant, lawyer, and admin roles.
- REST endpoints for posts, answers, follow-up discussions, folders, moderation, and stats.
- RAG chat sessions under `/api/rag/*` for pasted text, PDF uploads, and DOCX uploads.
- Mongo-backed session and application data.
- Citation-aware answers that can return both uploaded-source evidence and supporting handbook evidence.

## RAG grounding model

The RAG layer combines:
- Uploaded user material: pasted clause text, uploaded PDF, or uploaded DOCX.
- Ingested housing-rights reference material from the MassLegalHelp corpus configured by `RAG_CORPUS_ROOT`.

The ingested knowledge base is organized around:
- handbook chapters
- handouts
- forms
- booklets

Knowledge retrieval is stored in Milvus / Zilliz collections and answer generation is driven through the configured chat model endpoints.

## Key infrastructure

- Express
- MongoDB Atlas
- `pnpm`
- Milvus / Zilliz for vector search
- OpenAI-compatible chat and embedding clients
- Render for production hosting

## Local development

Requirements:
- Node `20.x`
- `pnpm`

Setup:

```bash
cp .env.example .env
pnpm install
pnpm dev
```

Default local server:
- `http://localhost:4000`

Expected local client:
- `http://localhost:3000`

## Important environment variables

- `DATABASE_CONNECTION_STRING`
- `CLIENT_URL`
- `SESSION_SECRET`
- `RAG_CORPUS_ROOT`
- `RAG_MILVUS_ADDRESS`
- `RAG_MILVUS_TOKEN`
- `RAG_MILVUS_KNOWLEDGE_COLLECTION`
- `RAG_MILVUS_SESSION_COLLECTION`
- `GEMINI_API_KEY`
- `GEMINI_CHAT_*`
- `RAG_CHAT_*`
- `RAG_EMBEDDING_*`

See [`.env.example`](/Users/Z1nk/Desktop/proj/leaseqa/leaseqa-server/.env.example) for the full template.

## Useful commands

```bash
pnpm dev
pnpm start
pnpm test:rag
pnpm eval:rag:smoke
pnpm ingest:rag
pnpm ingest:rag:reset
pnpm seed:demo-users
```

## Verification used for the current release

- `pnpm test:rag`
- production `/api/health`
- production `POST /api/rag/sessions` with a real pasted-text clause
