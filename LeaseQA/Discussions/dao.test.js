import test from "node:test";
import assert from "node:assert/strict";

import DiscussionModel from "./model.js";
import * as discussionsDao from "./dao.js";

const discussion = ({ _id, postId, parentId = null }) => ({
  _id,
  postId,
  parentId,
  authorId: `author-${_id}`,
  toObject() {
    return {
      _id: this._id,
      postId: this.postId,
      parentId: this.parentId,
      authorId: this.authorId,
    };
  },
});

test("findDiscussionTreesByPostIds performs one bulk read and keys trees by post ID", async (t) => {
  const originalFind = DiscussionModel.find;
  let query;
  let findCalls = 0;
  DiscussionModel.find = async (value) => {
    findCalls += 1;
    query = value;
    return [
      discussion({ _id: "root-1", postId: "post-1" }),
      discussion({ _id: "reply-1", postId: "post-1", parentId: "root-1" }),
      discussion({ _id: "root-2", postId: "post-2" }),
    ];
  };
  t.after(() => {
    DiscussionModel.find = originalFind;
  });

  const grouped = await discussionsDao.findDiscussionTreesByPostIds(["post-1", "post-2"]);

  assert.equal(findCalls, 1);
  assert.deepEqual(query, { postId: { $in: ["post-1", "post-2"] } });
  assert.equal(grouped.get("post-1")[0]._id, "root-1");
  assert.equal(grouped.get("post-1")[0].replies[0]._id, "reply-1");
  assert.equal(grouped.get("post-2")[0]._id, "root-2");
});
