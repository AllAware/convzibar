import { v } from "convex/values";

export const subjectValidator = v.object({
  type: v.string(),
  id: v.string(),
});

export const objectValidator = v.object({
  type: v.string(),
  id: v.string(),
});

export const propertiesValidator = v.optional(v.any());
