import test from "node:test";
import assert from "node:assert/strict";

import UserModel from "./model.js";
import * as usersDao from "./dao.js";

test("findUsersByIds performs one bulk user read", async (t) => {
  const originalFind = UserModel.find;
  let query;
  let findCalls = 0;
  const users = [{ _id: "user-1" }, { _id: "user-2" }];
  UserModel.find = async (value) => {
    findCalls += 1;
    query = value;
    return users;
  };
  t.after(() => {
    UserModel.find = originalFind;
  });

  const result = await usersDao.findUsersByIds(["user-1", "user-2"]);

  assert.equal(findCalls, 1);
  assert.deepEqual(query, { _id: { $in: ["user-1", "user-2"] } });
  assert.equal(result, users);
});
