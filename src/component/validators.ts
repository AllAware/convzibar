import { v } from "convex/values";

export const subjectValidator = v.object({
  type: v.string(),
  id: v.string(),
});

export const objectValidator = v.object({
  type: v.string(),
  id: v.string(),
});

export const conditionValidator = v.optional(
  v.object({
    condition: v.string(),
    conditionContext: v.optional(v.any()),
  }),
);
