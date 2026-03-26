"use client";

import React, { createContext, useContext } from "react";
import type { ReactNode } from "react";
import { useQuery } from "convex/react";

interface AuthzContextType<Data = any> {
  checkPermissionQuery: any;
  checkPermissionsQuery?: any;
  _dataMarker?: Data; // purely for type inference
}

const AuthzContext = createContext<AuthzContextType<any> | null>(null);

export interface AuthzProviderProps<Data = any> {
  checkPermissionQuery: any;
  checkPermissionsQuery?: any;
  children: ReactNode;
  _dataMarker?: Data; // purely for type inference
}

export function AuthzProvider<Data = any>({
  checkPermissionQuery,
  checkPermissionsQuery,
  children,
}: AuthzProviderProps<Data>) {
  return React.createElement(
    AuthzContext.Provider,
    { value: { checkPermissionQuery, checkPermissionsQuery } },
    children,
  );
}

export function useCan<Data = any>(
  permission: string,
  resource: { type: string; id: string },
  requestContext?: Data,
): boolean {
  const ctx = useContext(AuthzContext);
  if (!ctx) {
    throw new Error("useCan must be used within an AuthzProvider");
  }

  // The fallback is `false` while loading.
  // Depending on user preference, we might return undefined while loading,
  // but for conditional rendering `false` is generally safer.
  const result = useQuery(ctx.checkPermissionQuery, {
    permission,
    resource,
    requestContext,
  });

  return result ?? false;
}

export function usePermissions<Data = any>(
  resource: { type: string; id: string },
  permissions: string[],
  requestContext?: Data,
): Record<string, boolean> {
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

  return result ?? {};
}
