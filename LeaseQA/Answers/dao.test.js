import test from "node:test";
import assert from "node:assert/strict";

import AnswerModel from "./model.js";
import * as answersDao from "./dao.js";

test("findAnswersByPostIds performs one bulk read and keys answers by post ID", async (t) => {
  const originalFind = AnswerModel.find;
  let query;
  let findCalls = 0;
  AnswerModel.find = async (value) => {
    findCalls += 1;
    query = value;
    return [
      { _id: "answer-1", postId: "post-1" },
      { _id: "answer-2", postId: "post-1" },
      { _id: "answer-3", postId: "post-2" },
    ];
  };
  t.after(() => {
    AnswerModel.find = originalFind;
  });

  const grouped = await answersDao.findAnswersByPostIds(["post-1", "post-2"]);

  assert.equal(findCalls, 1);
  assert.deepEqual(query, { postId: { $in: ["post-1", "post-2"] } });
  assert.deepEqual(grouped.get("post-1").map((answer) => answer._id), ["answer-1", "answer-2"]);
  assert.deepEqual(grouped.get("post-2").map((answer) => answer._id), ["answer-3"]);
});
