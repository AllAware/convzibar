/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as audit from "../audit.js";
import type * as expand from "../expand.js";
import type * as helpers from "../helpers.js";
import type * as mutations from "../mutations.js";
import type * as paths from "../paths.js";
import type * as queries from "../queries.js";
import type * as runOrEnqueue from "../runOrEnqueue.js";
import type * as types from "../types.js";
import type * as unsafe from "../unsafe.js";
import type * as validators from "../validators.js";
import type * as workpool from "../workpool.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  audit: typeof audit;
  expand: typeof expand;
  helpers: typeof helpers;
  mutations: typeof mutations;
  paths: typeof paths;
  queries: typeof queries;
  runOrEnqueue: typeof runOrEnqueue;
  types: typeof types;
  unsafe: typeof unsafe;
  validators: typeof validators;
  workpool: typeof workpool;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  workpool: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"workpool">;
};
