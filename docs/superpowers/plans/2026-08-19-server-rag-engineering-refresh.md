# LeaseQA Server and RAG Engineering Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Secure and production-harden the LeaseQA Express backend and RAG pipeline while preserving its public response contracts.

**Architecture:** Introduce narrow policy and validation modules at the HTTP boundary, keep DAOs persistence-focused, and inject external RAG operations so timeout/retry/citation behavior is deterministic in tests. Replace destructive in-place corpus refresh with versioned collection activation and make session/vector lifecycle explicit.

**Tech Stack:** Node.js 24 LTS, Express, Mongoose, express-session/connect-mongo, Zod, sanitize-html, Helmet, Milvus/Zilliz SDK, LangChain Gemini/OpenAI compatibility, Node test runner, GitHub Actions, Render.

**Spec:** `docs/superpowers/specs/2026-08-19-engineering-refresh.md`

## Global Constraints

- Node 24 LTS is the declared local, CI, and Render runtime; Node 26 is a compatibility CI lane.
- Public JSON response envelopes remain compatible unless the endpoint is explicitly retired.
- External Milvus/Gemini tests use injected fakes; normal unit tests do not require network access.
- No real credentials, uploaded contracts, or `.env` contents enter tests, logs, or commits.
- Every behavior change follows red-green-refactor and commits only after its focused and regression tests pass.

---

### Task 1: Runtime, dependency, CI, and deployment baseline

**Files:**
- Create: `.nvmrc`
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `eslint.config.js`
- Modify: `.github/workflows/ci.yml`
- Modify: `render.yaml`
- Modify: `.env.example`
- Test: `LeaseQA/config/runtime.test.js`

**Interfaces:**
- Produces: Node `24.x` engine contract, `npm run lint`, `npm test`, `npm run test:coverage`, and deterministic deployment commands used by all later tasks.
- Consumes: Existing Node test files under `LeaseQA/**/*.test.js`.

- [ ] **Step 1: Add a failing runtime contract test**

```js
test("declares the supported production runtime", async () => {
  const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url)));
  assert.equal(pkg.engines.node, "24.x");
  assert.equal(pkg.packageManager.startsWith("npm@"), true);
});
```

- [ ] **Step 2: Run the test and verify it fails because `engines.node` is absent**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH node --test LeaseQA/config/runtime.test.js`

- [ ] **Step 3: Declare Node 24 and deterministic scripts, then upgrade direct dependencies within compatible majors**

Set `.nvmrc` to `24.19.0`; set `engines.node` to `24.x`; set `packageManager` to `npm@11.17.0`; add `test`, `test:coverage`, and ESLint scripts plus a flat ESLint configuration. Upgrade direct vulnerable packages to patched compatible releases and add `helmet`, `zod`, and `sanitize-html`. Task 3 owns removal of dependencies used only by the retired AI review route after confirming they are unused.

- [ ] **Step 4: Make CI and Render deterministic**

CI must run install, lint, all server tests, audit at high severity, and a Node 26 compatibility test lane. Render must use `npm ci`, set `NODE_VERSION=24.19.0`, and expose `/api/health` as its health check. Document every required variable in `.env.example` using placeholders only.

- [ ] **Step 5: Run focused and baseline verification**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm ci`

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run lint`

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm test`

- [ ] **Step 6: Commit**

```bash
git add .nvmrc package.json package-lock.json eslint.config.js .github/workflows/ci.yml render.yaml .env.example LeaseQA/config/runtime.test.js docs/superpowers
git commit -m "build: establish Node 24 server baseline"
```

### Task 2: Authentication, authorization, and HTTP security boundary

**Files:**
- Create: `LeaseQA/Auth/input.js`
- Create: `LeaseQA/Auth/input.test.js`
- Create: `LeaseQA/utils/httpSecurity.js`
- Create: `LeaseQA/utils/httpSecurity.test.js`
- Modify: `LeaseQA/Auth/routes.js`
- Modify: `LeaseQA/Auth/routes.test.js`
- Modify: `LeaseQA/Users/routes.js`
- Modify: `LeaseQA/Users/routes.test.js`
- Modify: `LeaseQA/Users/dao.js`
- Modify: `index.js`

**Interfaces:**
- Produces: `parseRegistration(body)`, `parseLogin(body)`, `parseProfileUpdate(body)`, `buildCorsOptions(env)`, and `assertProductionSessionConfig(env)`.
- Consumes: Existing `createAuthRouter` dependency injection and response-envelope helpers.

- [ ] **Step 1: Write failing route tests for privilege escalation and profile mass assignment**

```js
test("registration ignores privileged role and verification input", async () => {
  const response = await postRegister({ role: "admin", lawyerVerification: { barNumber: "x", state: "MA" } });
  assert.equal(response.status, 201);
  assert.equal(createdPayload.role, "tenant");
  assert.equal(createdPayload.lawyerVerification, undefined);
});

test("profile update rejects privileged fields", async () => {
  const response = await patchMe({ role: "admin" });
  assert.equal(response.status, 400);
  assert.equal(updateUserCalls.length, 0);
});
```

- [ ] **Step 2: Run the focused tests and verify the current routes fail them**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH node --test LeaseQA/Auth/input.test.js LeaseQA/Auth/routes.test.js LeaseQA/Users/routes.test.js`

- [ ] **Step 3: Implement strict Zod boundary schemas**

Registration accepts only normalized `username`, lower-cased `email`, and password; it produces role `tenant`. Profile update accepts only `username` and `avatarUrl` and rejects unknown keys. Login accepts only normalized email and password. Convert Zod failures to the existing `VALIDATION_ERROR` envelope.

- [ ] **Step 4: Write and run failing session-fixation tests**

Assert that register and login invoke `req.session.regenerate`, attach only the sanitized user after regeneration, and save once. The test must fail against the current direct assignment implementation.

- [ ] **Step 5: Implement regenerated sessions and redact authentication logs**

Remove logs containing email, user objects, session IDs, or session contents. Preserve operational logs using event names only. Make registration/login fail with the existing internal-error envelope if regeneration or save fails.

- [ ] **Step 6: Write failing CORS and production-config tests**

```js
assert.equal(corsOrigin("https://leaseqa-client.vercel.app"), true);
assert.equal(corsOrigin("https://attacker.vercel.app"), false);
assert.throws(() => assertProductionSessionConfig({ SERVER_ENV: "production" }), /SESSION_SECRET/);
```

- [ ] **Step 7: Add explicit-origin CORS, Helmet, request IDs, and centralized error handling**

Use `CLIENT_URL` plus comma-separated `CORS_ALLOWED_ORIGINS`; never wildcard subdomains with credentials. In production require a non-placeholder `SESSION_SECRET`, set secure cookies, disable `x-powered-by`, attach Helmet, and return a request ID in unexpected-error responses without exposing stack, Node version, or raw error text.

- [ ] **Step 8: Run focused and full regression tests**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH node --test LeaseQA/Auth/*.test.js LeaseQA/Users/*.test.js LeaseQA/utils/httpSecurity.test.js`

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm test`

- [ ] **Step 9: Commit**

```bash
git add LeaseQA/Auth LeaseQA/Users LeaseQA/utils/httpSecurity.js LeaseQA/utils/httpSecurity.test.js index.js
git commit -m "fix: enforce server authentication boundaries"
```

### Task 3: Community content, moderation, uploads, and query efficiency

**Files:**
- Create: `LeaseQA/utils/richText.js`
- Create: `LeaseQA/utils/richText.test.js`
- Create: `LeaseQA/app.js`
- Create: `LeaseQA/config/app.test.js`
- Create: `LeaseQA/Posts/uploadPolicy.js`
- Create: `LeaseQA/Posts/uploadPolicy.test.js`
- Create: `LeaseQA/Posts/dao.test.js`
- Modify: `LeaseQA/Users/schema.js`
- Modify: `LeaseQA/Posts/schema.js`
- Modify: `LeaseQA/Posts/routes.js`
- Modify: `LeaseQA/Posts/routes.test.js`
- Modify: `LeaseQA/Answers/dao.js`
- Create: `LeaseQA/Answers/dao.test.js`
- Modify: `LeaseQA/Answers/routes.js`
- Modify: `LeaseQA/Answers/routes.test.js`
- Modify: `LeaseQA/Discussions/dao.js`
- Create: `LeaseQA/Discussions/dao.test.js`
- Modify: `LeaseQA/Discussions/routes.js`
- Modify: `LeaseQA/Users/dao.js`
- Create: `LeaseQA/Users/dao.test.js`
- Modify: `LeaseQA/Moderation/routes.js`
- Create: `LeaseQA/Moderation/routes.test.js`
- Modify: `LeaseQA/Stats/routes.js`
- Create: `LeaseQA/Stats/routes.test.js`
- Modify: `index.js`
- Modify: `.env.example`

**Interfaces:**
- Produces: `sanitizeRichText(html)`, `createAttachmentUpload(env)`, persisted `User.banned`, persisted `Post.isHidden`, and bulk DAO contracts for post enrichment.
- Consumes: Authentication policy from Task 2 and existing response envelopes.

- [ ] **Step 1: Write failing behavioral tests for stored HTML, bans, hidden posts, lawyer verification, and stats authorization**

Use payloads containing `<script>`, `onerror`, and `javascript:` and assert persisted content removes executable markup while retaining paragraphs/lists. Assert ban and hide updates return resolved documents and persist declared fields. Assert unverified lawyers receive 403 for `lawyer_opinion`. Assert tenant/guest stats requests receive 401/403 and admin receives data.

- [ ] **Step 2: Run the focused tests and verify each fails for the audited reason**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH node --test LeaseQA/utils/richText.test.js LeaseQA/Moderation/routes.test.js LeaseQA/Stats/routes.test.js LeaseQA/Answers/routes.test.js`

- [ ] **Step 3: Implement content sanitization and schema-backed moderation state**

Allow only semantic rich-text tags and safe `http`, `https`, and `mailto` links. Sanitize posts, answers, and discussions before DAO writes. Add `banned: {type:Boolean, default:false}` and `isHidden: {type:Boolean, default:false}`. Await moderation DAO operations and return 404 only after a resolved null.

- [ ] **Step 4: Implement verified-lawyer and administrator policies**

Lawyer opinions require `role === "lawyer"` and a valid `lawyerVerification.verifiedAt`. Statistics require `admin`. Hidden posts are excluded for non-admin viewers.

- [ ] **Step 5: Write failing attachment-policy tests**

Assert files over 10 MiB, executable/HTML/SVG MIME types, and mismatched extensions are rejected; accepted PDF/JPEG/PNG/DOCX files receive random server filenames and a configured absolute storage root.

- [ ] **Step 6: Implement bounded attachment storage**

Use `UPLOADS_DIR` when present and require it to be absolute. `UPLOADS_ENABLED` defaults to `false` in production and `true` in development; in production, fail startup if attachments are explicitly enabled without a configured persistent directory. A local absolute fallback is allowed only outside production. Do not provision external storage in this task. Never expose original filenames as paths. Add `X-Content-Type-Options: nosniff` on attachment responses.

- [ ] **Step 7: Write failing bounded-query tests, then bulk-load post relations**

For multiple posts assert one answers query, one discussions query, and one users query rather than one set per post. Task 3 may modify the Answers, Discussions, and Users DAOs to add bulk methods keyed by post ID and preserve the existing JSON shape.

- [ ] **Step 8: Retire the unused legacy AI review router**

Remove its mount from the application assembly used by `index.js`; add an HTTP integration assertion that `/api/ai-reviews/*` returns 404. Delete the legacy module only after repository search confirms no production imports.

- [ ] **Step 9: Run focused and full tests, then commit**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH node --test LeaseQA/Posts/*.test.js LeaseQA/Answers/*.test.js LeaseQA/Discussions/*.test.js LeaseQA/Moderation/*.test.js LeaseQA/Stats/*.test.js LeaseQA/utils/richText.test.js`

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm test`

```bash
git add LeaseQA index.js .env.example docs/superpowers/plans/2026-08-19-server-rag-engineering-refresh.md package.json package-lock.json
git commit -m "fix: harden community content and moderation"
```

### Task 4: RAG prompt, timeout, retry, and citation integrity

**Files:**
- Create: `LeaseQA/RAG/operationPolicy.js`
- Create: `LeaseQA/RAG/operationPolicy.test.js`
- Create: `LeaseQA/RAG/prompt.js`
- Create: `LeaseQA/RAG/prompt.test.js`
- Modify: `LeaseQA/RAG/service.js`
- Modify: `LeaseQA/RAG/structuredAnswer.test.js`
- Modify: `LeaseQA/RAG/serviceCitationSupport.test.js`
- Modify: `LeaseQA/RAG/config.js`
- Modify: `.env.example`

**Interfaces:**
- Produces: `withTimeout(operation, timeoutMs, label)`, `retryTransient(operation, policy)`, `buildRagMessages(input)`, and citation normalization that accepts explicit valid citation IDs only.
- Consumes: Existing retrieval/citation selection output and LangChain message-compatible `chatModel.invoke(messages)`.

- [ ] **Step 1: Write failing timeout and retry tests**

Test that timeout rejects with a stable `RAG_TIMEOUT` code, HTTP 429/5xx/network errors retry at most three total attempts, HTTP 400/401/403 do not retry, and injected sleep/random functions make backoff deterministic.

- [ ] **Step 2: Run tests and confirm current direct provider calls do not satisfy the contract**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH node --test LeaseQA/RAG/operationPolicy.test.js`

- [ ] **Step 3: Implement bounded provider operations**

Add separate configurable embedding, chat, and vector timeouts with defaults of 15s, 45s, and 10s. Use exponential delays capped at 2s with jitter; never retry validation/auth failures. Ensure timers are cleared.

- [ ] **Step 4: Write failing prompt-boundary tests**

Assert the model receives distinct system and user messages; system content says evidence and uploaded text are untrusted data and cannot override instructions; evidence entries use stable IDs and explicit delimiters; raw evidence never appears in the system message.

- [ ] **Step 5: Implement message-separated prompting and structured output validation**

Use a Zod schema for answer sections and citation IDs. Reject unknown citation IDs. When model output is invalid, return an abstention with no citations; do not attach all retrieved citations as fallback support.

- [ ] **Step 6: Add regression tests for citation fabrication and prompt injection**

An answer without explicit support IDs must return zero citations. Evidence containing `ignore previous instructions` must remain quoted user-data content. A selected citation absent from retrieval must be dropped and must not contribute to the reliability gate.

- [ ] **Step 7: Run all RAG and server tests, then commit**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run test:rag`

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm test`

```bash
git add LeaseQA/RAG .env.example package.json package-lock.json
git commit -m "feat: bound and validate RAG generation"
```

### Task 5: RAG lifecycle, atomic ingestion, observability, and evaluation

**Files:**
- Modify: `LeaseQA/RAG/schema.js`
- Modify: `LeaseQA/RAG/dao.js`
- Modify: `LeaseQA/RAG/routes.js`
- Modify: `LeaseQA/RAG/routes.test.js`
- Modify: `LeaseQA/RAG/milvus.js`
- Create: `LeaseQA/RAG/lifecycle.test.js`
- Modify: `LeaseQA/RAG/ingestState.js`
- Create: `LeaseQA/RAG/ingestState.test.js`
- Modify: `LeaseQA/RAG/service.js`
- Modify: `scripts/ingest-rag-corpus.js`
- Modify: `scripts/run-rag-eval.js`
- Modify: `LeaseQA/RAG/evals/tenant-rights-eval.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`

**Interfaces:**
- Produces: `DELETE /api/rag/sessions/:sessionId`, `deleteSessionChunks(sessionId)`, versioned corpus activation metadata, JSON evaluation artifacts, and non-zero threshold enforcement.
- Consumes: Provider policies from Task 4 and existing session ownership helpers.

- [ ] **Step 1: Write failing lifecycle tests**

Assert session deletion requires ownership, removes Milvus chunks before Mongo completion, is idempotent for already-absent vectors, and returns the existing data envelope. Add `expiresAt` with a 30-day default and TTL index for guest/session metadata.

- [ ] **Step 2: Implement deletion and retention lifecycle**

Add DAO and Milvus deletion methods, an authenticated-or-guest-session ownership check, and the route. Ensure deletion failures do not report success while one store still contains user data; return a stable retryable error.

- [ ] **Step 3: Write failing atomic-ingestion tests**

Simulate parse, embedding, and insert failures and assert the active collection/version remains unchanged. For success assert staging collection creation, manifest SHA-256 recording, complete insert, alias activation, and old-version cleanup only after activation.

- [ ] **Step 4: Implement versioned corpus ingestion**

Use corpus version `sha256(manifest contents + sorted source hashes)`. Write to `leaseqa_knowledge_chunks_<version-prefix>`, record source hash/page/section metadata, then atomically point a stable alias at the staged collection. Correct the default corpus root to `../resources/rag-corpus/mass tenant rights` relative to the server workspace and document override behavior.

- [ ] **Step 5: Add request-scoped RAG observability**

Record structured, redacted metrics for request ID, retrieval duration, provider duration, selected citation IDs, corpus version, abstention, and error code. Never log questions, uploaded content, evidence text, keys, or session cookies.

- [ ] **Step 6: Write failing evaluation-runner tests**

Use a local fake HTTP server fixture. Assert JSON output includes per-case latency, expected-source match, explicit citation validity, abstention, and summary; assert exit code 1 below `RAG_EVAL_MIN_PASS_RATE=0.90` or `RAG_EVAL_MIN_SAFE_RATE=0.98`, and 0 when thresholds are met.

- [ ] **Step 7: Implement deterministic and live RAG evaluation layers**

Keep 25 live retrieval cases and add adversarial injection, unsupported-answer, and citation-integrity cases. CI runs deterministic contract tests without credentials. A separately triggerable workflow runs live evaluation, uploads the JSON artifact, and enforces committed thresholds when required secrets are present.

- [ ] **Step 8: Run focused, full, and script verification**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run test:rag`

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm test`

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH node scripts/run-rag-eval.js --help`

- [ ] **Step 9: Commit**

```bash
git add LeaseQA/RAG scripts .github/workflows/ci.yml README.md
git commit -m "feat: add RAG lifecycle and regression gates"
```
