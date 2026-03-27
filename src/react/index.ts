"use client";

import React, { createContext, useContext } from "react";
import type { ReactNode } from "react";
import { useQuery } from "convex/react";
import type {
  ZbarSchema,
  EntityPermissions,
  EntityRelations,
} from "../client/index.js";

// Utility to infer the Data type from the Schema
type InferData<Schema extends ZbarSchema<any>> =
  Schema extends ZbarSchema<infer D> ? D : any;

export interface ZbarContextType {
  checkPermissionQuery: any;
  checkPermissionsQuery?: any;
  hasRelationshipQuery?: any;
  getRelationshipsQuery?: any;
}

export interface ZbarProviderProps {
  checkPermissionQuery: any;
  checkPermissionsQuery?: any;
  hasRelationshipQuery?: any;
  getRelationshipsQuery?: any;
  children: ReactNode;
}

export function createReactZbar<Schema extends ZbarSchema<any>>(
  _schema?: Schema,
) {
  type Data = InferData<Schema>;

  const ZbarContext = createContext<ZbarContextType | null>(null);

  function ZbarProvider({
    checkPermissionQuery,
    checkPermissionsQuery,
    hasRelationshipQuery,
    getRelationshipsQuery,
    children,
  }: ZbarProviderProps) {
    return React.createElement(
      ZbarContext.Provider,
      {
        value: {
          checkPermissionQuery,
          checkPermissionsQuery,
          hasRelationshipQuery,
          getRelationshipsQuery,
        },
      },
      children,
    );
  }

  function useCan<
    ObjectType extends keyof Schema["entities"] & string,
    Permission extends EntityPermissions<Schema, ObjectType>,
  >(
    permission: Permission,
    resource: { type: ObjectType; id: string },
    requestContext?: Data,
  ): boolean {
    const ctx = useContext(ZbarContext);
    if (!ctx) {
      throw new Error("useCan must be used within an ZbarProvider");
    }

    // The fallback is `false` while loading.
    const result = useQuery(ctx.checkPermissionQuery, {
      permission,
      resource,
      requestContext,
    });

    return result ?? false;
  }

  function usePermissions<
    ObjectType extends keyof Schema["entities"] & string,
    Permission extends EntityPermissions<Schema, ObjectType>,
  >(
    resource: { type: ObjectType; id: string },
    permissions: Permission[],
    requestContext?: Data,
  ): Record<Permission, boolean> {
    const ctx = useContext(ZbarContext);
    if (!ctx) {
      throw new Error("usePermissions must be used within an ZbarProvider");
    }

    if (!ctx.checkPermissionsQuery) {
      throw new Error(
        "usePermissions requires checkPermissionsQuery to be passed to ZbarProvider",
      );
    }

    const result = useQuery(ctx.checkPermissionsQuery, {
      resource,
      permissions,
      requestContext,
    });

    return result ?? ({} as Record<Permission, boolean>);
  }

  function useHasRelationship<
    ObjectType extends keyof Schema["entities"] & string,
    Relation extends EntityRelations<Schema, ObjectType>,
  >(
    relation: Relation,
    resource: { type: ObjectType; id: string },
    requestContext?: Data,
  ): boolean {
    const ctx = useContext(ZbarContext);
    if (!ctx) {
      throw new Error("useHasRelationship must be used within a ZbarProvider");
    }

    if (!ctx.hasRelationshipQuery) {
      throw new Error(
        "useHasRelationship requires hasRelationshipQuery to be passed to ZbarProvider",
      );
    }

    const result = useQuery(ctx.hasRelationshipQuery, {
      relation,
      resource,
      requestContext,
    });

    return result ?? false;
  }

  function useGetRelationships<
    ObjectType extends keyof Schema["entities"] & string,
  >(
    resource: { type: ObjectType; id: string },
    requestContext?: Data,
    options?: { includeInherited?: boolean },
  ): Array<EntityRelations<Schema, ObjectType>> {
    const ctx = useContext(ZbarContext);
    if (!ctx) {
      throw new Error("useGetRelationships must be used within a ZbarProvider");
    }

    if (!ctx.getRelationshipsQuery) {
      throw new Error(
        "useGetRelationships requires getRelationshipsQuery to be passed to ZbarProvider",
      );
    }

    const result = useQuery(ctx.getRelationshipsQuery, {
      resource,
      requestContext,
      options,
    });

    return result ?? [];
  }

  return {
    ZbarProvider,
    useCan,
    usePermissions,
    useHasRelationship,
    useGetRelationships,
  };
}
