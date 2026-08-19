import { z } from "zod";

const normalizedEmail = z.string().trim().toLowerCase().email();
const requiredText = z.string().trim().min(1);
const password = z.string().min(1);

const registrationSchema = z
  .object({
    username: requiredText,
    email: normalizedEmail,
    password,
  })
  .transform((input) => ({ ...input, role: "tenant" }));

const loginSchema = z
  .object({
    email: normalizedEmail,
    password,
  })
  .strict();

const profileUpdateSchema = z
  .object({
    username: requiredText.optional(),
    avatarUrl: z.url().optional(),
  })
  .strict()
  .refine((input) => Object.keys(input).length > 0, {
    message: "At least one profile field is required.",
  });

export const parseRegistration = (body) => registrationSchema.parse(body);
export const parseLogin = (body) => loginSchema.parse(body);
export const parseProfileUpdate = (body) => profileUpdateSchema.parse(body);
