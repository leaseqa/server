import test from "node:test";
import assert from "node:assert/strict";

import { createStudyService } from "./service.js";

const createScenario = () => ({
  scenarioId: "security-deposit",
  title: "Security deposit return",
  introduction: "A landlord may have missed the deadline to return a deposit.",
  sourceName: "study-security-deposit.txt",
  sourceText: "Tenant moved out on May 31 and has not received the deposit.",
  mainQuestion:
    "What does Massachusetts law say about this situation, and what should the tenant check next?",
});

test("createStudySession creates a backing rag session from the fixed scenario packet", async () => {
  const calls = [];
  const service = createStudyService({
    getScenarioById: (scenarioId) => {
      assert.equal(scenarioId, "security-deposit");
      return createScenario();
    },
    assignCondition: () => ({
      conditionId: "condition-high-professional_personalized",
      boundaryCue: "high",
      framing: "professional_personalized",
    }),
    studyDao: {
      findReusableStudySession: async () => null,
      createStudySession: async (payload) => ({
        _id: "study-1",
        status: "active",
        turnCount: 0,
        ...payload,
      }),
      updateStudySession: async (studySessionId, payload) => ({
        _id: studySessionId,
        participantId: "participant-1",
        scenarioId: "security-deposit",
        conditionId: "condition-high-professional_personalized",
        boundaryCue: "high",
        framing: "professional_personalized",
        status: "active",
        turnCount: 0,
        ...payload,
      }),
    },
    ragService: {
      createRagSession: async (payload) => {
        calls.push(payload);
        return {
          _id: "rag-1",
          status: "ready",
          messages: [],
        };
      },
    },
  });

  const session = await service.createStudySession({
    participantId: "participant-1",
    scenarioId: "security-deposit",
    clientSessionId: "browser-session-1",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].sourceText, createScenario().sourceText);
  assert.equal(calls[0].studyMetadata.studySessionId, "study-1");
  assert.equal(session.ragSessionId, "rag-1");
  assert.equal(session.scenario.mainQuestion, createScenario().mainQuestion);
});

test("sendStudyMessage uses the saved rag session and injects framing", async () => {
  const increments = [];
  const service = createStudyService({
    getScenarioById: () => createScenario(),
    studyDao: {
      findStudySessionById: async () => ({
        _id: "study-1",
        participantId: "participant-1",
        scenarioId: "security-deposit",
        ragSessionId: "rag-1",
        framing: "professional_personalized",
        status: "active",
        turnCount: 0,
      }),
      incrementTurnCount: async (studySessionId, nextTurnCount) => {
        increments.push([studySessionId, nextTurnCount]);
        return {
          _id: studySessionId,
          participantId: "participant-1",
          scenarioId: "security-deposit",
          ragSessionId: "rag-1",
          framing: "professional_personalized",
          status: "active",
          turnCount: nextTurnCount,
        };
      },
    },
    ragService: {
      answerQuestion: async (payload) => {
        assert.equal(payload.sessionId, "rag-1");
        assert.equal(payload.studyFraming, "professional_personalized");
        return {
          session: {
            _id: "rag-1",
            status: "ready",
            messages: [
              {
                role: "user",
                content: createScenario().mainQuestion,
              },
              {
                role: "assistant",
                content: "A tenant may have remedies if the deadline passed.",
              },
            ],
          },
          answer: "A tenant may have remedies if the deadline passed.",
          citations: [],
        };
      },
    },
    maxFollowUps: 2,
  });

  const result = await service.sendStudyMessage({
    studySessionId: "study-1",
    clientSessionId: "browser-session-1",
    message: createScenario().mainQuestion,
  });

  assert.deepEqual(increments, [["study-1", 1]]);
  assert.equal(result.studySession.turnCount, 1);
  assert.equal(result.studySession.remainingFollowUps, 2);
  assert.equal(result.studySession.ragSession._id, "rag-1");
});

test("sendStudyMessage rejects a different first-turn question", async () => {
  const service = createStudyService({
    getScenarioById: () => createScenario(),
    studyDao: {
      findStudySessionById: async () => ({
        _id: "study-1",
        scenarioId: "security-deposit",
        ragSessionId: "rag-1",
        framing: "informational_detached",
        status: "active",
        turnCount: 0,
      }),
    },
    ragService: {
      answerQuestion: async () => {
        throw new Error("should not be called");
      },
    },
  });

  await assert.rejects(
    () =>
      service.sendStudyMessage({
        studySessionId: "study-1",
        clientSessionId: "browser-session-1",
        message: "Can I sue immediately?",
      }),
    /fixed main question/i,
  );
});

test("sendStudyMessage rejects when follow-up budget is exhausted", async () => {
  const service = createStudyService({
    getScenarioById: () => createScenario(),
    studyDao: {
      findStudySessionById: async () => ({
        _id: "study-1",
        scenarioId: "security-deposit",
        ragSessionId: "rag-1",
        framing: "informational_detached",
        status: "active",
        turnCount: 3,
      }),
    },
    ragService: {
      answerQuestion: async () => {
        throw new Error("should not be called");
      },
    },
    maxFollowUps: 2,
  });

  await assert.rejects(
    () =>
      service.sendStudyMessage({
        studySessionId: "study-1",
        clientSessionId: "browser-session-1",
        message: "One more follow-up",
      }),
    /follow-up limit/i,
  );
});
