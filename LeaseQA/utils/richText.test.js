import test from "node:test";
import assert from "node:assert/strict";

import { sanitizeRichText } from "./richText.js";

test("sanitizeRichText removes executable markup while retaining semantic content", () => {
  const sanitized = sanitizeRichText(`
    <p>Tenant <strong>rights</strong><img src=x onerror="alert(1)"></p>
    <ul><li><a href="javascript:alert(1)" onclick="alert(2)">unsafe</a></li></ul>
    <ol><li><a href="https://example.com/help">safe</a></li></ol>
    <script>alert(3)</script>
  `);

  assert.match(sanitized, /<p>Tenant <strong>rights<\/strong><\/p>/);
  assert.match(sanitized, /<ul><li><a>unsafe<\/a><\/li><\/ul>/);
  assert.match(sanitized, /<ol><li><a href="https:\/\/example\.com\/help">safe<\/a><\/li><\/ol>/);
  assert.doesNotMatch(sanitized, /script|onerror|onclick|javascript:|<img/i);
});

test("sanitizeRichText allows only http, https, and mailto link schemes", () => {
  const sanitized = sanitizeRichText(`
    <p><a href="http://example.com">http</a></p>
    <p><a href="mailto:help@example.com">mail</a></p>
    <p><a href="data:text/html,boom">data</a></p>
  `);

  assert.match(sanitized, /href="http:\/\/example\.com"/);
  assert.match(sanitized, /href="mailto:help@example\.com"/);
  assert.doesNotMatch(sanitized, /data:text\/html/);
});
