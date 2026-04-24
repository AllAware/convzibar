/* eslint-disable @typescript-eslint/no-empty-object-type */
import type { PropertyValidators } from "convex/values";
import type { BuiltZbarSchema, ConditionFunction } from "../types";
import type {
  EntityUsersetPath,
  ReverseTargetRelations,
  TargetRelationKeys,
} from "./builder-types";

export class EntityBuilder<
  EntName extends string,
  Conditions extends Record<string, any>,
  Entities extends Record<
    string,
    { relations: Record<string, string>; permissions: string; properties: Record<string, PropertyValidators> }
  >,
  Relations extends Record<string, string> = {},
  Permissions extends string = never,
  Reverses extends Record<string, { relations: Record<string, string>; properties: Record<string, PropertyValidators> }> = {},
  Properties extends Record<string, PropertyValidators> = {},
> {
  declare _relations: Relations;
  declare _permissions: Permissions;
  declare _reverses: Reverses;
  declare _properties: Properties;

  public def: any = { relations: {}, permissions: {}, propertyValidators: {} };

  /**
   * When true, `.relation()` merges new targets into existing relation
   * definitions instead of overwriting them. Set by `SchemaBuilder.extend()`.
   */
  public _mergeMode = false;

  /**
   * Placeholder overload: declares a relation name with no subject type.
   * Used for reverse-edge targets that will be populated by entities
   * defined later in the schema chain.
   *
   * ```ts
   * .entity('system', e => e
   *   .relation('device_member')  // placeholder — populated by device.owner reverse
   * )
   * ```
   */
  relation<RelName extends string>(
    name: RelName,
  ): EntityBuilder<
    EntName,
    Conditions,
    Entities,
    Relations & Record<RelName, string>,
    Permissions,
    Reverses,
    Properties
  >;

  /**
   * Full overload: declares a relation with one or more typed targets.
   */
  relation<
    RelName extends string,
    Target extends (keyof Entities | EntName) & string = (keyof Entities | EntName) & string,
    RTarget extends (keyof Entities | EntName) & string = never,
    RRev extends string = never,
  >(
    name: RelName,
    ...targets: Array<
      | Target
      | keyof Relations
      | {
          [K in keyof Relations &
            string]: `${K}.${TargetRelationKeys<Relations[K], EntName, Relations, Entities>}`;
        }[keyof Relations & string]
      | EntityUsersetPath<EntName, RelName, Relations, Entities>
      | { type: Target }
      | { type: RTarget; reverse: RRev & ReverseTargetRelations<RTarget, EntName, Relations, Entities> }
      | {
          relation:
            | keyof Relations
            | {
                [K in keyof Relations &
                  string]: `${K}.${TargetRelationKeys<Relations[K], EntName, Relations, Entities>}`;
              }[keyof Relations & string]
            | EntityUsersetPath<EntName, RelName, Relations, Entities>;
          condition: keyof Conditions & string;
        }
    >
  ): EntityBuilder<
    EntName,
    Conditions,
    Entities,
    Relations & Record<RelName, Target>,
    Permissions,
    Reverses & ([RRev] extends [never] ? {} : Record<RTarget & string, { relations: Record<RRev & string, EntName>; properties: {} }>),
    Properties
  >;

  // Implementation
  relation(name: string, ...targets: any[]): any {
    if (targets.length === 0) {
      this.def.relations[name] = this.def.relations[name] ?? undefined;
      return this;
    }

    const newValue = targets.length === 1 ? targets[0] : targets;

    // In merge mode (used by .extend()), append new targets to any
    // existing relation definition instead of replacing it.
    const existing = this.def.relations[name];
    if (this._mergeMode && existing != null) {
      const existingArr = Array.isArray(existing) ? existing : [existing];
      const newArr = Array.isArray(newValue) ? newValue : [newValue];
      // Deduplicate: skip targets that are already present (by reference
      // equality for objects, strict equality for strings).
      const merged = [...existingArr];
      for (const t of newArr) {
        const isDuplicate = merged.some((m) =>
          typeof t === "string" && typeof m === "string" ? t === m
          : typeof t === "object" && typeof m === "object" && t !== null && m !== null
            ? JSON.stringify(t) === JSON.stringify(m)
            : false,
        );
        if (!isDuplicate) {
          merged.push(t);
        }
      }
      this.def.relations[name] = merged.length === 1 ? merged[0] : merged;
    } else {
      this.def.relations[name] = newValue;
    }

    return this;
  }

  permission<PermName extends string>(
    name: PermName,
    ...targets: Array<
      | keyof Relations
      | { relation: keyof Relations; condition: keyof Conditions & string }
    >
  ): EntityBuilder<
    EntName,
    Conditions,
    Entities,
    Relations,
    Permissions | PermName,
    Reverses,
    Properties
  > {
    this.def.permissions[name] = targets;
    return this as any;
  }

  /**
   * Define typed properties for a relation using Convex validators.
   *
   * Properties are stored on direct edges and returned by `.listDirect()`.
   * They are validated at write-time by the client before being persisted.
   *
   * ```ts
   * .entity('project', e => e
   *   .relation('editor', 'user')
   *   .properties('editor', {
   *     weight: v.number(),
   *     note: v.optional(v.string()),
   *     since: v.string(),
   *   })
   * )
   * ```
   */
  properties<
    RelName extends keyof Relations & string,
    P extends PropertyValidators,
  >(
    relation: RelName,
    validators: P,
  ): EntityBuilder<
    EntName,
    Conditions,
    Entities,
    Relations,
    Permissions,
    Reverses,
    Properties & Record<RelName, P>
  > {
    this.def.propertyValidators[relation] = validators;
    return this as any;
  }

  /**
   * Declare a path that should be evaluated at **read time** rather than
   * materialised at write time. Unlike targets passed to `.relation()` (which
   * fan out across the entire subject population and write one effective
   * edge per pair), read-time paths produce **no** traversal rules. `can()`
   * and `list()` evaluate them on demand using 2–3 indexed queries.
   *
   * Two path forms are supported:
   *
   *   1. Dot-path `'source.target'` — follow the local `source` relation to
   *      an intermediate entity, then pick up its `target` relation:
   *
   *      ```ts
   *      .entity('contact', e => e
   *        .relation('owner', { type: 'system' })
   *        .relation('viewer', 'user')
   *        .readTimeRelation('viewer', 'owner.viewer')
   *      )
   *      ```
   *
   *   2. Userset `'type#target'` — when a subject of `type` is assigned to
   *      the derived relation, expand through that entity's `target` relation
   *      at read time. The derived relation must declare `type` as a typed
   *      target (either `{ type: 'X' }` or the bare string `'X'`).
   *
   *      ```ts
   *      .entity('device', e => e
   *        .relation('viewer', 'user', { type: 'group' })
   *        .readTimeRelation('viewer', 'group#viewer')
   *      )
   *      ```
   *
   * Use this for relationships that would be prohibitively expensive to
   * materialise — e.g. paths that traverse high-fan-out memberships — while
   * still keeping the permission model concise. The `derivedRelation` must
   * already exist on the current entity (declared via `.relation()`). The
   * results of the read-time path are **unioned** with any materialised
   * results when evaluating `can()` / `list()`.
   */
  readTimeRelation(
    derivedRelation: keyof Relations & string,
    ...paths: string[]
  ): this {
    for (const path of paths) {
      if (!path.includes(".") && !path.includes("#")) {
        throw new Error(
          `Zbar Schema Error: readTimeRelation requires a dot-path ('source.target') or a userset ('type#target'). Got '${path}'.`,
        );
      }
      if (path.includes(".") && path.includes("#")) {
        throw new Error(
          `Zbar Schema Error: readTimeRelation path '${path}' mixes '.' and '#'; use exactly one.`,
        );
      }
      this.def.readTimeRelations = this.def.readTimeRelations ?? [];
      this.def.readTimeRelations.push({ derivedRelation, dotPath: path });
    }
    return this;
  }
}

export class SchemaBuilder<
  Data,
  Conditions extends Record<string, any> = {},
  Entities extends Record<
    string,
    { relations: Record<string, string>; permissions: string; properties: Record<string, PropertyValidators> }
  > = {},
> {
  public _schema: any = { conditions: {}, entities: {} };

  condition<Name extends string>(
    name: Name,
    fn: ConditionFunction<Data>,
  ): SchemaBuilder<Data, Conditions & Record<Name, true>, Entities> {
    this._schema.conditions[name] = fn;
    return this as any;
  }

  entity<
    Name extends string,
    Rel extends Record<string, string> = {},
    Perm extends string = never,
    Rev extends Record<string, { relations: Record<string, string>; properties: Record<string, PropertyValidators> }> = {},
    Props extends Record<string, PropertyValidators> = {},
  >(
    name: Name,
    build?: (
      e: EntityBuilder<Name, Conditions, Entities, {}, never, {}, {}>,
    ) => EntityBuilder<Name, Conditions, Entities, Rel, Perm, Rev, Props>,
  ): SchemaBuilder<
    Data,
    Conditions,
    Entities & Record<Name, { relations: Rel; permissions: Perm; properties: Props }> & Rev
  > {
    if (build) {
      const e = build(new EntityBuilder());
      this._schema.entities[name] = e.def;
    } else {
      this._schema.entities[name] = { relations: {}, permissions: {} };
    }
    return this as any;
  }

  /**
   * Extend an already-defined entity with additional relations and/or permissions.
   *
   * Use this to add forward references that depend on entities defined later
   * in the schema chain. By the time `.extend()` is called, those entities
   * (and their relations) are visible to the type system.
   *
   * ```ts
   * createZbarSchema()
   *   .entity('system', e => e
   *     .relation('has_group')           // placeholder
   *     .relation('owner', 'user')
   *   )
   *   .entity('group', e => e
   *     .relation('owner', { type: 'system', reverse: 'has_group' })
   *     .relation('device_member')
   *   )
   *   // Now group.device_member exists — wire up the forward reference:
   *   .extend('system', e => e
   *     .relation('device_member', 'has_group.device_member')
   *   )
   *   .build()
   * ```
   */
  extend<
    Name extends keyof Entities & string,
    NewRel extends Record<string, string> = {},
    NewPerm extends string = never,
    Rev extends Record<string, { relations: Record<string, string>; properties: Record<string, PropertyValidators> }> = {},
    NewProps extends Record<string, PropertyValidators> = {},
  >(
    name: Name,
    build: (
      e: EntityBuilder<Name, Conditions, Entities, Entities[Name]["relations"], Entities[Name]["permissions"], {}, Entities[Name]["properties"]>,
    ) => EntityBuilder<Name, Conditions, Entities, Entities[Name]["relations"] & NewRel, Entities[Name]["permissions"] | NewPerm, Rev, Entities[Name]["properties"] & NewProps>,
  ): SchemaBuilder<
    Data,
    Conditions,
    Omit<Entities, Name> & Record<Name, { relations: Entities[Name]["relations"] & NewRel; permissions: Entities[Name]["permissions"] | NewPerm; properties: Entities[Name]["properties"] & NewProps }> & Rev
  > {
    const existing = this._schema.entities[name];
    if (!existing) {
      throw new Error(
        `Zbar Schema Error: Cannot extend entity '${name}' — it has not been defined yet. Call .entity('${name}', ...) first.`,
      );
    }

    // Seed a new EntityBuilder with the existing definition so the callback
    // can reference already-declared relations in dot-paths / permissions.
    // Enable merge mode so that .relation() appends to existing definitions
    // instead of overwriting them.
    const builder = new EntityBuilder();
    builder.def = {
      relations: { ...existing.relations },
      permissions: { ...existing.permissions },
      propertyValidators: { ...existing.propertyValidators },
      ...(existing.readTimeRelations
        ? { readTimeRelations: [...existing.readTimeRelations] }
        : {}),
    };
    builder._mergeMode = true;

    const result = build(builder as any);

    // Merge the (potentially new) relations and permissions back.
    this._schema.entities[name] = result.def;
    return this as any;
  }

  build(): BuiltZbarSchema<Data, Conditions, Entities> {
    // Reverse-edge wiring happens at runtime in `parseSchemaToGraphConfig`.
    // `build()` just returns the raw schema — no pre-computation needed.
    return this._schema;
  }
}

export function createZbarSchema<Data = any>() {
  return new SchemaBuilder<Data>();
}
