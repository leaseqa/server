import test from "node:test";
import assert from "node:assert/strict";

import PostModel from "./model.js";
import { listPosts } from "./dao.js";

const captureListQuery = async (t, filters) => {
  const originalFind = PostModel.find;
  let capturedQuery;
  PostModel.find = (query) => {
    capturedQuery = query;
    return { sort: async () => [] };
  };
  t.after(() => {
    PostModel.find = originalFind;
  });

  await listPosts(filters);
  return capturedQuery;
};

test("listPosts excludes hidden posts for non-admin viewers", async (t) => {
  const query = await captureListQuery(t, { viewerRole: "tenant" });
  assert.deepEqual(query.isHidden, { $ne: true });
});

test("listPosts permits administrators to query hidden posts", async (t) => {
  const query = await captureListQuery(t, { viewerRole: "admin" });
  assert.equal(Object.hasOwn(query, "isHidden"), false);
});
