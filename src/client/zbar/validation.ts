import type { GenericValidator } from "convex/values";
import type { ActionCtx, MutationCtx, QueryCtx, ZbarInternal } from "../internal";
import type { PolicyContext, SubjectOrObject } from "../types";

/**
 * Verify that the (subject.type, relation, object.type) triple is consistent
 * with what the schema declares. Throws a descriptive error otherwise.
 */
export function validateRelationParameter(
  z: ZbarInternal,
  subject: { type: string },
  relation: string,
  object: { type: string },
) {
  const objectEntity = z.schema.entities[object.type];

  if (!objectEntity?.relations || !(relation in objectEntity.relations)) {
    throw new Error(
      `Zbar Schema Error: Relation '${relation}' is not defined for object type '${object.type}'.`,
    );
  }

  const relDef = objectEntity.relations[relation];
  const defs = Array.isArray(relDef) ? relDef : [relDef];
  const localRelations = objectEntity.relations;
  const validSubjectTypes = new Set<string>();

  for (const d of defs) {
    if (typeof d === "string") {
      if (d.includes("#")) {
        validSubjectTypes.add(d.split("#")[0]);
      } else if (d.includes(".")) {
        // traversal dot-path — not a subject type
      } else if (z.schema.entities[d] && !localRelations[d]) {
        // entity type name (not a local relation reference)
        validSubjectTypes.add(d);
      }
    } else if (typeof d === "object" && d !== null && "type" in d) {
      validSubjectTypes.add((d as { type: string }).type);
    }
  }

  if (validSubjectTypes.size > 0 && !validSubjectTypes.has(subject.type)) {
    throw new Error(
      `Zbar Schema Error: Subject type '${subject.type}' is not a valid subject for relation '${relation}' on object type '${object.type}'. Valid subject types: ${[...validSubjectTypes].join(", ")}.`,
    );
  }
}

/**
 * Validate edge properties against the schema-defined validators.
 * Throws if required fields are missing or types don't match.
 */
export function validateProperties(
  z: ZbarInternal,
  objectType: string,
  relation: string,
  properties: unknown,
) {
  const entityDef = z.schema.entities[objectType];
  const validators = entityDef?.propertyValidators?.[relation];

  if (!validators) {
    throw new Error(
      `Zbar Schema Error: No properties defined for relation '${relation}' on entity type '${objectType}'. ` +
      `Remove the 'properties' option or define properties with .properties('${relation}', { ... }) in the schema.`,
    );
  }

  if (typeof properties !== "object" || properties === null) {
    throw new Error(
      `Zbar Schema Error: Properties for relation '${relation}' on '${objectType}' must be an object.`,
    );
  }

  const props = properties as Record<string, unknown>;

  // Check for required fields (non-optional validators)
  for (const [key, validator] of Object.entries(validators)) {
    const val = validator as GenericValidator;
    if (val.isOptional !== "optional" && !(key in props)) {
      throw new Error(
        `Zbar Schema Error: Missing required property '${key}' for relation '${relation}' on '${objectType}'.`,
      );
    }
  }

  // Check for unknown fields
  for (const key of Object.keys(props)) {
    if (!(key in validators)) {
      throw new Error(
        `Zbar Schema Error: Unknown property '${key}' for relation '${relation}' on '${objectType}'. ` +
        `Defined properties: ${Object.keys(validators).join(", ")}.`,
      );
    }
  }
}

/**
 * Invoke a single named condition with the standard policy context. Returns
 * `false` on throw so a buggy condition fails closed rather than 500-ing.
 */
export async function evaluateCondition<Data>(
  z: ZbarInternal,
  conditionName: string,
  ctx: QueryCtx | ActionCtx | MutationCtx,
  subject: SubjectOrObject,
  object: SubjectOrObject,
  permission: string,
  data: Data,
): Promise<boolean | Partial<Data>> {
  const conditionFn = z.schema.conditions?.[conditionName];
  if (!conditionFn) return false;

  const policyCtx: PolicyContext<Data> = {
    subject,
    resource: object,
    action: permission,
    data,
  };

  try {
    return await Promise.resolve(conditionFn(ctx as any, policyCtx));
  } catch {
    return false;
  }
}

/**
 * Walk a single materialised path's conditions plus the target's own
 * condition. Each condition can short-circuit (false) or augment the data
 * carried forward (object return). Returns true only if every gate passes.
 */
export async function validatePath<Data>(
  z: ZbarInternal,
  path: any,
  targetDef: { relation: string; condition?: string } | undefined,
  ctx: QueryCtx | ActionCtx | MutationCtx,
  subject: SubjectOrObject,
  object: SubjectOrObject,
  permission: string,
  requestContext?: Data,
): Promise<boolean> {
  let currentData = {
    ...(requestContext || {}),
    ...(path.conditions?.[0]?.conditionContext || {}),
  } as Data;

  if (path.conditions) {
    for (const c of path.conditions) {
      // Include context from the relationship edge
      if (c !== path.conditions[0] && c.conditionContext) {
        currentData = { ...currentData, ...c.conditionContext };
      }

      const ok = await evaluateCondition(
        z,
        c.condition,
        ctx,
        subject,
        object,
        permission,
        currentData,
      );
      if (ok === false) {
        return false;
      } else if (typeof ok === "object" && ok !== null) {
        currentData = { ...currentData, ...ok };
      }
    }
  }

  if (targetDef?.condition) {
    const ok = await evaluateCondition(
      z,
      targetDef.condition,
      ctx,
      subject,
      object,
      permission,
      currentData,
    );
    if (ok === false) {
      return false;
    }
  }

  return true;
}

/**
 * Filter a batch of effective relations down to those that pass condition
 * validation, deduplicating by extracted id. Used by both list-objects and
 * list-subjects flows — the resolvers parameterise how subject/object are
 * built from each row.
 */
export async function listWithValidation<Data, T extends { id: string }>(
  z: ZbarInternal,
  ctx: QueryCtx | ActionCtx,
  effectiveRels: any[],
  targets: Array<{ relation: string; condition?: string }>,
  getId: (eff: any) => string,
  subjectResolver: (eff: any, id: string) => SubjectOrObject,
  objectResolver: (eff: any, id: string) => SubjectOrObject,
  permission: string,
  requestContext?: Data,
): Promise<T[]> {
  const results: T[] = [];
  const seen = new Set<string>();
  for (const eff of effectiveRels) {
    const id = getId(eff);
    if (seen.has(id)) continue;

    const targetDef = targets.find((t) => t.relation === eff.relation);
    let valid = false;

    for (const path of eff.paths) {
      const subject = subjectResolver(eff, id);
      const object = objectResolver(eff, id);
      const isValid = await validatePath(
        z,
        path,
        targetDef,
        ctx,
        subject,
        object,
        permission,
        requestContext,
      );
      if (isValid) {
        valid = true;
        break;
      }
    }
    if (valid) {
      seen.add(id);
      results.push({ id } as T);
    }
  }
  return results;
}
