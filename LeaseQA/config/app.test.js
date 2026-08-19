import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createApplication } from "../app.js";
import { createAttachmentUpload } from "../Posts/uploadPolicy.js";

test("application retires legacy AI review HTTP routes and serves attachments nosniff", async (t) => {
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), "leaseqa-app-uploads-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  await writeFile(path.join(storageRoot, "safe.pdf"), "%PDF-test");

  const attachmentUpload = createAttachmentUpload({
    SERVER_ENV: "production",
    UPLOADS_ENABLED: "true",
    UPLOADS_DIR: storageRoot,
  });
  const app = createApplication({
    env: {
      CLIENT_URL: "https://leaseqa-client.vercel.app",
      CI_DISABLE_RATE_LIMIT: "true",
    },
    attachmentUpload,
    sessionMiddleware: (req, _res, next) => {
      req.session = {};
      next();
    },
  });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const [legacyResponse, attachmentResponse] = await Promise.all([
    fetch(`${baseUrl}/api/ai-reviews/legacy-id`),
    fetch(`${baseUrl}/uploads/safe.pdf`),
  ]);

  assert.equal(legacyResponse.status, 404);
  assert.equal(attachmentResponse.status, 200);
  assert.equal(attachmentResponse.headers.get("x-content-type-options"), "nosniff");
});
