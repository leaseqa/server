import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createAttachmentUpload } from "./uploadPolicy.js";

const startUploadApp = async (t, policy) => {
  const app = express();
  app.post("/upload", policy.array("files", 5), (req, res) => {
    res.json({
      files: req.files.map((file) => ({
        filename: file.filename,
        path: file.path,
        mimetype: file.mimetype,
        size: file.size,
      })),
    });
  });
  app.use("/uploads", policy.serve);
  app.use((error, _req, res, _next) => {
    res.status(400).json({ error: { code: error.code || "UPLOAD_REJECTED" } });
  });

  const server = app.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  return `http://127.0.0.1:${server.address().port}`;
};

const uploadFiles = (baseUrl, files) => {
  const body = new FormData();
  for (const file of files) {
    body.append("files", new Blob([file.content], { type: file.type }), file.name);
  }
  return fetch(`${baseUrl}/upload`, { method: "POST", body });
};

test("attachment uploads default off in production and on in development", () => {
  const production = createAttachmentUpload({ SERVER_ENV: "production" });
  const development = createAttachmentUpload({ SERVER_ENV: "development" });

  assert.equal(production.enabled, false);
  assert.equal(production.storageRoot, null);
  assert.equal(development.enabled, true);
  assert.equal(path.isAbsolute(development.storageRoot), true);
});

test("production upload enablement requires a configured absolute storage root", () => {
  assert.throws(
    () => createAttachmentUpload({ SERVER_ENV: "production", UPLOADS_ENABLED: "true" }),
    /UPLOADS_DIR/,
  );
  assert.throws(
    () => createAttachmentUpload({
      SERVER_ENV: "production",
      UPLOADS_ENABLED: "true",
      UPLOADS_DIR: "relative/uploads",
    }),
    /absolute/,
  );
});

test("attachment policy rejects oversized, unsafe, and MIME-extension mismatched files", async (t) => {
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), "leaseqa-upload-reject-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const policy = createAttachmentUpload({
    SERVER_ENV: "development",
    UPLOADS_DIR: storageRoot,
  });
  const baseUrl = await startUploadApp(t, policy);

  const cases = [
    {
      name: "too-large.pdf",
      type: "application/pdf",
      content: new Uint8Array((10 * 1024 * 1024) + 1),
      code: "LIMIT_FILE_SIZE",
    },
    { name: "page.html", type: "text/html", content: "<script>x</script>" },
    { name: "image.svg", type: "image/svg+xml", content: "<svg/>" },
    { name: "program.exe", type: "application/x-msdownload", content: "MZ" },
    { name: "renamed.png", type: "application/pdf", content: "%PDF" },
  ];

  for (const fixture of cases) {
    const response = await uploadFiles(baseUrl, [fixture]);
    const payload = await response.json();
    assert.equal(response.status, 400, fixture.name);
    assert.equal(payload.error.code, fixture.code || "UNSUPPORTED_ATTACHMENT_TYPE", fixture.name);
  }
});

test("accepted attachments use random filenames under the configured root and are served nosniff", async (t) => {
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), "leaseqa-upload-accept-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const policy = createAttachmentUpload({
    SERVER_ENV: "production",
    UPLOADS_ENABLED: "true",
    UPLOADS_DIR: storageRoot,
  });
  const baseUrl = await startUploadApp(t, policy);
  const fixtures = [
    { name: "lease.pdf", type: "application/pdf", content: "%PDF-test" },
    { name: "photo.jpeg", type: "image/jpeg", content: new Uint8Array([0xff, 0xd8, 0xff]) },
    { name: "scan.png", type: "image/png", content: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
    {
      name: "notice.docx",
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      content: "PK-test",
    },
  ];

  const response = await uploadFiles(baseUrl, fixtures);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.files.length, fixtures.length);
  for (const [index, file] of payload.files.entries()) {
    assert.match(file.filename, /^[0-9a-f-]{36}\.(?:pdf|jpeg|png|docx)$/);
    assert.notEqual(file.filename, fixtures[index].name);
    assert.equal(path.dirname(file.path), storageRoot);
    await access(file.path);
    assert.equal((await readFile(file.path)).length, fixtures[index].content.length);
  }

  const served = await fetch(`${baseUrl}/uploads/${payload.files[0].filename}`);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("x-content-type-options"), "nosniff");
});
