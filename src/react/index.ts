"use client";

import { useQuery } from "convex/react";
import type { FunctionReference } from "convex/server";
import type {
  ZbarSchema,
  EntityPermissions,
  EntityRelations,
} from "../client/index.js";

export function createReactZbar<Schema extends ZbarSchema<any>>(queries: {
  checkPermissionQuery: FunctionReference<
    "query",
    "public",
    { resource: { type: string; id: string }; permission: string },
    boolean
  >;
  hasRelationshipQuery: FunctionReference<
    "query",
    "public",
    { relation: string; resource: { type: string; id: string } },
    boolean
  >;
  getRelationshipsQuery: FunctionReference<
    "query",
    "public",
    {
      resource: { type: string; id: string };
      options?: { includeInherited?: boolean };
    },
    string[]
  >;
}) {
  function useCan<
    ObjectType extends keyof Schema["entities"] & string,
    Permission extends EntityPermissions<Schema, ObjectType>,
  >(
    resource: { type: ObjectType; id: string },
    permission: Permission[]
  ): boolean {
    // The fallback is `false` while loading.
    const result = useQuery(queries.checkPermissionQuery, {
      permissions: [permission],
      resource,
    } as any);

    return result ?? false;
  }

  function useHasRelationship<
    ObjectType extends keyof Schema["entities"] & string,
    Relation extends EntityRelations<Schema, ObjectType>,
  >(relation: Relation, resource: { type: ObjectType; id: string }): boolean {
    const result = useQuery(queries.hasRelationshipQuery, {
      relation,
      resource,
    } as any);

    return result ?? false;
  }

  function useGetRelationships<
    ObjectType extends keyof Schema["entities"] & string,
  >(
    resource: { type: ObjectType; id: string },
    options?: { includeInherited?: boolean },
  ): Array<EntityRelations<Schema, ObjectType>> {
    const result = useQuery(queries.getRelationshipsQuery, {
      resource,
      options,
    } as any);

    return (result as Array<EntityRelations<Schema, ObjectType>>) ?? [];
  }

  return {
    useCan,
    useHasRelationship,
    useGetRelationships,
  };
}
