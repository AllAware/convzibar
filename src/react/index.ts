"use client";

import React, { createContext, useContext } from "react";
import type { ReactNode } from "react";
import { useQuery } from "convex/react";
import type { AuthSchema, EntityPermissions } from "../client/index.js";

// Utility to infer the Data type from the Schema
type InferData<Schema extends AuthSchema<any>> =
  Schema extends AuthSchema<infer D> ? D : any;

export interface AuthzContextType {
  checkPermissionQuery: any;
  checkPermissionsQuery?: any;
}

export interface AuthzProviderProps {
  checkPermissionQuery: any;
  checkPermissionsQuery?: any;
  children: ReactNode;
}

export function createReactAuthz<Schema extends AuthSchema<any>>(
  _schema?: Schema,
) {
  type Data = InferData<Schema>;

  const AuthzContext = createContext<AuthzContextType | null>(null);

  function AuthzProvider({
    checkPermissionQuery,
    checkPermissionsQuery,
    children,
  }: AuthzProviderProps) {
    return React.createElement(
      AuthzContext.Provider,
      { value: { checkPermissionQuery, checkPermissionsQuery } },
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
    const ctx = useContext(AuthzContext);
    if (!ctx) {
      throw new Error("useCan must be used within an AuthzProvider");
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
    const ctx = useContext(AuthzContext);
    if (!ctx) {
      throw new Error("usePermissions must be used within an AuthzProvider");
    }

    if (!ctx.checkPermissionsQuery) {
      throw new Error(
        "usePermissions requires checkPermissionsQuery to be passed to AuthzProvider",
      );
    }

    const result = useQuery(ctx.checkPermissionsQuery, {
      resource,
      permissions,
      requestContext,
    });

    return result ?? ({} as Record<Permission, boolean>);
  }

  return { AuthzProvider, useCan, usePermissions };
}
