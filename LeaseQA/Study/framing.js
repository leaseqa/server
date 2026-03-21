const FRAMING_INSTRUCTIONS = {
  professional_personalized: `
Use a careful professional helper tone.
Refer to the renter as "you" and "your situation" when it fits the evidence.
Emphasize what matters most for this renter's next step.
If the evidence supports it, include cautious next-step guidance.
Do not present the assistant as a lawyer or law firm.
`.trim(),
  informational_detached: `
Present general legal information in a detached tone.
Avoid telling the renter what they should do.
Avoid personalized recommendation language unless the user explicitly asks for it.
Prefer neutral descriptions of rules, options, deadlines, and conditions.
Do not present the assistant as a lawyer or law firm.
`.trim(),
};

export const getFramingInstructions = (framing) =>
  FRAMING_INSTRUCTIONS[framing] || FRAMING_INSTRUCTIONS.informational_detached;
