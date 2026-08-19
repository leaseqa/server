# LeaseQA Server and RAG Engineering Refresh Specification

## Goal

Make the existing Express/Mongo/Milvus service safe to resume development on: close confirmed authorization and content-security defects, establish a reproducible Node 24 baseline, and turn the RAG path into a bounded, observable, regression-tested subsystem.

## Required outcomes

- Node 24 LTS is the declared local, CI, and Render runtime; Node 26 is a compatibility CI lane.
- Installation uses `npm ci` in CI and Render.
- Public registration always creates a tenant. Self-service profile updates cannot change role, verification, ban state, IDs, or authentication fields.
- Login and registration regenerate the session before attaching the authenticated user. Production refuses a missing or placeholder session secret.
- CORS uses an explicit allowlist. Arbitrary `*.vercel.app` origins are rejected. Security headers and structured request/error handling are enabled.
- User ban and post hide state are real schema fields and are covered by behavioral tests. Only verified lawyers can submit lawyer opinions.
- Community statistics require an administrator. The unused legacy AI review HTTP API is no longer mounted.
- Rich-text content is sanitized before persistence. Attachments have bounded size, MIME and extension allowlists, randomized names, and a configured storage root.
- Post-list enrichment performs bounded bulk reads rather than per-post answer, discussion, and user lookups.
- Direct dependencies are upgraded to patched compatible versions; automated audit, lint, test, and coverage commands exist.
- RAG model prompts separate system instructions from user material and explicitly treat retrieved/uploaded text as untrusted data.
- Embedding, chat, and vector operations have timeouts and retry only transient failures with bounded exponential backoff and jitter.
- RAG structured answers never invent citation support. Every returned citation is explicitly selected by a model output or deterministic abstention path.
- RAG sessions and vector chunks have a deletion/retention lifecycle; deletion removes both Mongo and Milvus data.
- Knowledge ingestion builds a versioned staging collection and activates it only after a complete successful ingest. Manifest hashes and corpus version are recorded.
- RAG evaluation measures answer presence, expected retrieval, citation support, abstention, latency, and exits non-zero below committed thresholds. CI has a deterministic RAG contract suite; live-provider evaluation remains a separate job.
- No real credentials, uploaded contracts, or `.env` contents enter tests, logs, or commits.

## Compatibility boundaries

- Existing public JSON response envelopes remain compatible unless the endpoint is explicitly retired.
- Existing Mongo documents without new fields continue to read safely through defaults.
- External Milvus/Gemini tests use injected fakes; normal unit tests do not require network access.
- Production object-storage provisioning is outside this repository. The server must make local-disk behavior explicit and configurable instead of silently relying on Render's ephemeral default.

