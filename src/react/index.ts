"use client";

import React, { createContext, useContext } from "react";
import type { ReactNode } from "react";
import { useQuery } from "convex/react";
import type { ZbarSchema, EntityPermissions } from "../client/index.js";

// Utility to infer the Data type from the Schema
type InferData<Schema extends ZbarSchema<any>> =
  Schema extends ZbarSchema<infer D> ? D : any;

export interface ZbarContextType {
  checkPermissionQuery: any;
  checkPermissionsQuery?: any;
}

export interface ZbarProviderProps {
  checkPermissionQuery: any;
  checkPermissionsQuery?: any;
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
    children,
  }: ZbarProviderProps) {
    return React.createElement(
      ZbarContext.Provider,
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

  return { ZbarProvider, useCan, usePermissions };
}
