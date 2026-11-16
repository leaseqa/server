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

test("sanitizeUser drops the hash and says whether there is a password", () => {
  assert.deepEqual(
    usersDao.sanitizeUser({ _id: "user-1", hashedPassword: "hash" }),
    { _id: "user-1", hasPassword: true },
  );
  assert.deepEqual(
    usersDao.sanitizeUser({ _id: "user-2", googleId: "google-1" }),
    { _id: "user-2", googleId: "google-1", hasPassword: false },
  );
});

test("updatePassword stores a bcrypt hash, never the password itself", async (t) => {
  const originalFindByIdAndUpdate = UserModel.findByIdAndUpdate;
  let call;
  UserModel.findByIdAndUpdate = async (id, updates, options) => {
    call = { id, updates, options };
    return { _id: id };
  };
  t.after(() => {
    UserModel.findByIdAndUpdate = originalFindByIdAndUpdate;
  });

  await usersDao.updatePassword("user-1", "new-secret");

  assert.equal(call.id, "user-1");
  assert.deepEqual(call.options, { new: true });
  assert.notEqual(call.updates.hashedPassword, "new-secret");
  assert.ok(usersDao.verifyPassword("new-secret", call.updates.hashedPassword));
});
