# LeaseQA Server

This repository contains the Express API and RAG services used by the LeaseQA web client.

Canonical product docs live in the client repo:

- Product PRD: [leaseqa-client/docs/product-prd.md](/Users/Z1nk/Desktop/proj/leaseqa/leaseqa-client/docs/product-prd.md)
- Architecture: [leaseqa-client/docs/architecture.md](/Users/Z1nk/Desktop/proj/leaseqa/leaseqa-client/docs/architecture.md)
- API design summary: [leaseqa-client/docs/api-design.md](/Users/Z1nk/Desktop/proj/leaseqa/leaseqa-client/docs/api-design.md)
- Release checklist: [leaseqa-client/docs/release-checklist.md](/Users/Z1nk/Desktop/proj/leaseqa/leaseqa-client/docs/release-checklist.md)

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
- ingested housing-rights reference material from the MassLegalHelp corpus configured by `RAG_CORPUS_ROOT`

The ingested knowledge base is organized around:

- handbook chapters
- handouts
- forms
- booklets

Knowledge retrieval is stored in Milvus / Zilliz collections and answer generation is driven through the configured chat model endpoints.

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
- `pnpm`
- Milvus / Zilliz for vector search
- OpenAI-compatible chat and embedding clients
- Render for production hosting

## Local Development

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

## Important Environment Variables

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

See [.env.example](/Users/Z1nk/Desktop/proj/leaseqa/leaseqa-server/.env.example) for the full template.

## Useful Commands

```bash
pnpm dev
pnpm start
pnpm test:rag
pnpm eval:rag:smoke
pnpm ingest:rag
pnpm ingest:rag:reset
pnpm seed:demo-users
```

## Verification Used for the Current Release

- `pnpm test:rag`
- `node --test LeaseQA/Activity/routes.test.js LeaseQA/Auth/routes.test.js LeaseQA/Answers/routes.test.js LeaseQA/Discussions/routes.test.js LeaseQA/Posts/routes.test.js LeaseQA/RAG/sessionBootstrap.test.js`
- production `/api/health`
