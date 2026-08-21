import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("declares the supported production runtime", async () => {
  const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url)));
  assert.equal(pkg.engines.node, "26.x");
  assert.equal(pkg.packageManager.startsWith("npm@"), true);
});
