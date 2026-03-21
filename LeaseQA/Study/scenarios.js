const STUDY_SCENARIOS = {
  "security-deposit": {
    scenarioId: "security-deposit",
    title: "Security deposit return",
    introduction:
      "A renter moved out and believes the landlord missed the deadline to return a security deposit or provide a lawful itemized deduction.",
    taskInstructions:
      "Read the situation below, then use LeaseQA to understand what Massachusetts law may require and what facts still matter.",
    sourceName: "study-security-deposit.txt",
    sourceText: `
Scenario packet for a Massachusetts renter:

- The tenant rented an apartment in Massachusetts and paid a $1,800 security deposit at move-in.
- The tenant moved out on May 31 after giving proper notice.
- The landlord has not sent back the deposit.
- The tenant also has not received a signed itemized list of damages with receipts.
- The tenant has photos of the apartment from move-out and bank records showing the original deposit payment.
- The tenant wants to know what the law says, what deadlines matter, and what facts should be checked before taking a next step.
`.trim(),
    mainQuestion:
      "What does Massachusetts law say about this situation, and what should the tenant check next?",
  },
};

export const getScenarioById = (scenarioId) => {
  const scenario = STUDY_SCENARIOS[scenarioId];
  if (!scenario) {
    throw new Error("Unknown study scenario");
  }
  return scenario;
};

export const listStudyScenarios = () => Object.values(STUDY_SCENARIOS);

