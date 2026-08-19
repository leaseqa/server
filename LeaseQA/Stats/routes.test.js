import test from "node:test";
import assert from "node:assert/strict";

import router from "./routes.js";
import UserModel from "../Users/model.js";
import PostModel from "../Posts/model.js";
import AnswerModel from "../Answers/model.js";
import FolderModel from "../Folders/model.js";

const getOverviewHandler = () => {
  const layer = router.stack.find(
    (entry) => entry.route?.path === "/overview" && entry.route.methods?.get === true,
  );
  assert.ok(layer, "Expected GET /overview route");
  return layer.route.stack[0].handle;
};

const createResponse = () => ({
  statusCode: 200,
  payload: undefined,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.payload = body;
    return this;
  },
});

const stubOverviewModels = (t) => {
  const originals = {
    postCountDocuments: PostModel.countDocuments,
    answerDistinct: AnswerModel.distinct,
    answerCountDocuments: AnswerModel.countDocuments,
    userCountDocuments: UserModel.countDocuments,
    userFind: UserModel.find,
    folderFind: FolderModel.find,
  };
  t.after(() => {
    PostModel.countDocuments = originals.postCountDocuments;
    AnswerModel.distinct = originals.answerDistinct;
    AnswerModel.countDocuments = originals.answerCountDocuments;
    UserModel.countDocuments = originals.userCountDocuments;
    UserModel.find = originals.userFind;
    FolderModel.find = originals.folderFind;
  });

  let postCountCalls = 0;
  PostModel.countDocuments = async () => {
    postCountCalls += 1;
    return 4;
  };
  AnswerModel.distinct = async () => [];
  AnswerModel.countDocuments = async () => 0;
  UserModel.countDocuments = async () => 2;
  UserModel.find = async () => [];
  FolderModel.find = async () => [];

  return () => postCountCalls;
};

test("GET /overview rejects unauthenticated requests before querying statistics", async (t) => {
  const postCountCalls = stubOverviewModels(t);
  const res = createResponse();

  await getOverviewHandler()({ session: {} }, res);

  assert.equal(res.statusCode, 401);
  assert.equal(res.payload.error.code, "UNAUTHORIZED");
  assert.equal(postCountCalls(), 0);
});

test("GET /overview rejects non-admin users before querying statistics", async (t) => {
  const postCountCalls = stubOverviewModels(t);
  const res = createResponse();

  await getOverviewHandler()({
    session: { currentUser: { _id: "tenant-1", role: "tenant" } },
  }, res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.payload.error.code, "FORBIDDEN");
  assert.equal(postCountCalls(), 0);
});

test("GET /overview returns statistics to an administrator", async (t) => {
  const postCountCalls = stubOverviewModels(t);
  const res = createResponse();

  await getOverviewHandler()({
    session: { currentUser: { _id: "admin-1", role: "admin" } },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.totalPosts, 4);
  assert.equal(res.payload.data.enrolledUsers, 2);
  assert.equal(postCountCalls(), 4);
});
