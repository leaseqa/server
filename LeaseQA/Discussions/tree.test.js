import test from "node:test";
import assert from "node:assert/strict";

import { annotateDiscussionTreeAuthors, collectDiscussionAuthorIds, collectDiscussionSubtreeIds, } from "./tree.js";

test("collectDiscussionAuthorIds walks every nested reply depth", () => {
  const tree = [
    {
      _id: "root",
      authorId: "admin",
      replies: [
        {
          _id: "child",
          authorId: "tenant",
          replies: [
            {
              _id: "grandchild",
              authorId: "lawyer",
              replies: [],
            },
          ],
        },
      ],
    },
  ];

  assert.deepEqual(collectDiscussionAuthorIds(tree), ["admin", "tenant", "lawyer"]);
});

test("annotateDiscussionTreeAuthors attaches authors recursively", () => {
  const tree = [
    {
      _id: "root",
      authorId: "admin",
      replies: [
        {
          _id: "child",
          authorId: "tenant",
          replies: [
            {
              _id: "grandchild",
              authorId: "lawyer",
              replies: [],
            },
          ],
        },
      ],
    },
  ];
  const userMap = {
    admin: { email: "admin@leaseqa.dev" },
    tenant: { email: "tenant@leaseqa.dev" },
    lawyer: { email: "lawyer@leaseqa.dev" },
  };

  const annotated = annotateDiscussionTreeAuthors(tree, userMap);

  assert.equal(annotated[0].author.email, "admin@leaseqa.dev");
  assert.equal(annotated[0].replies[0].author.email, "tenant@leaseqa.dev");
  assert.equal(
    annotated[0].replies[0].replies[0].author.email,
    "lawyer@leaseqa.dev",
  );
});

test("collectDiscussionSubtreeIds includes all descendants for deep threads", () => {
  const nodes = [
    { _id: "root", parentId: null },
    { _id: "child", parentId: "root" },
    { _id: "grandchild", parentId: "child" },
    { _id: "sibling", parentId: null },
  ];

  assert.deepEqual(
    collectDiscussionSubtreeIds(nodes, "root"),
    ["root", "child", "grandchild"],
  );
});
