import type { AnyComponent } from "npm:preact@^10.20.2";
import type { App } from "../../app.ts";
import type { WalkEntry } from "jsr:/@std/fs@^0.221.0/walk";
import * as path from "jsr:@std/path@^0.221.0";
import type { RouteConfig } from "../../types.ts";
import type { RouteHandler } from "../../handlers.ts";
import type { FreshContext } from "../../context.ts";
import type { MiddlewareFn } from "../../middlewares/mod.ts";
import {
  type AsyncAnyComponent,
  renderMiddleware,
} from "./render_middleware.ts";
import { type Method, pathToPattern } from "../../router.ts";
import { type HandlerFn, isHandlerByMethod } from "../../handlers.ts";
import { type FsAdapter, fsAdapter } from "../../fs.ts";
import type { PageProps } from "../../runtime/server/mod.tsx";
import { HttpError } from "../../error.ts";

const TEST_FILE_PATTERN = /[._]test\.(?:[tj]sx?|[mc][tj]s)$/;
const GROUP_REG = /(^|[/\\\\])\((_[^/\\\\]+)\)[/\\\\]/;

interface InternalRoute<State> {
  path: string;
  base: string;
  filePath: string;
  config: RouteConfig | null;
  handlers: RouteHandler<unknown, State> | null;
  component: AnyComponent<PageProps<unknown, State>> | null;
}

export interface FreshFsItem<State> {
  config?: RouteConfig;
  handler?: RouteHandler<unknown, State> | HandlerFn<unknown, State>[];
  handlers?: RouteHandler<unknown, State>;
  default?:
    | AnyComponent<
      PageProps<unknown, State> & Pick<FreshContext<unknown, State>, "redirect">
    >
    | AsyncAnyComponent<
      PageProps<unknown, State> & Pick<FreshContext<unknown, State>, "redirect">
    >;
}

// deno-lint-ignore no-explicit-any
function isFreshFile<State>(mod: any): mod is FreshFsItem<State> {
  return mod !== null && typeof mod === "object" &&
      typeof mod.default === "function" ||
    typeof mod.config === "object" || typeof mod.handlers === "object" ||
    typeof mod.handlers === "function" || typeof mod.handler === "object" ||
    typeof mod.handler === "function";
}

export interface FsRoutesOptions {
  dir: string;
  ignoreFilePattern?: RegExp[];
  loadRoute: (path: string) => Promise<unknown>;
  loadIsland: (path: string) => Promise<unknown>;
}

export interface TESTING_ONLY__FsRoutesOptions {
  _fs?: FsAdapter;
}

export async function fsRoutes<State>(
  app: App<State>,
  options_: FsRoutesOptions,
) {
  const options = options_ as FsRoutesOptions & TESTING_ONLY__FsRoutesOptions;
  const ignore = options.ignoreFilePattern ?? [TEST_FILE_PATTERN];
  const fs = options._fs ?? fsAdapter;

  const islandDir = path.join(options.dir, "islands");
  const routesDir = path.join(options.dir, "routes");

  const islandPaths: string[] = [];
  const relRoutePaths: string[] = [];

  // Walk routes folder
  console.time("Walking folders");
  await Promise.all([
    walkDir(
      islandDir,
      (entry) => {
        islandPaths.push(entry.path);
      },
      ignore,
      fs,
    ),
    walkDir(
      routesDir,
      (entry) => {
        const relative = path.relative(routesDir, entry.path);

        // A `(_islands)` path segment is a local island folder.
        // Any route path segment wrapped in `(_...)` is ignored
        // during route collection.
        const match = relative.match(GROUP_REG);
        if (match && match[2][0] === "_") {
          if (match[2] === "_islands") {
            islandPaths.push(entry.path);
          }
          return;
        }

        relRoutePaths.push(relative);
      },
      ignore,
      fs,
    ),
  ]);
  console.timeEnd("Walking folders");

  console.time("Load islands");
  await Promise.all(islandPaths.map(async (islandPath) => {
    const relative = path.relative(islandDir, islandPath);
    // deno-lint-ignore no-explicit-any
    const mod = await options.loadIsland(relative) as any;
    for (const key of Object.keys(mod)) {
      const maybeFn = mod[key];
      if (typeof maybeFn === "function") {
        app.island(islandPath, key, maybeFn);
      }
    }
  }));
  console.timeEnd("Load islands");

  console.time("Load routes");
  const routeModules: InternalRoute<State>[] = await Promise.all(
    relRoutePaths.map(async (routePath) => {
      const mod = await options.loadRoute(routePath);
      if (!isFreshFile(mod)) {
        throw new Error(
          `Expected a route, middleware, layout or error template, but couldn't find relevant exports in: ${routePath}`,
        );
      }

      const handlers = mod.handlers ?? mod.handler ?? null;
      if (typeof handlers === "function" && handlers.length > 1) {
        throw new Error(
          `Handlers must only have one argument but found more than one. Check the function signature in: ${
            path.join(routesDir, routePath)
          }`,
        );
      }

      const normalizedPath = `/${
        routePath.slice(0, routePath.lastIndexOf("."))
      }`;
      const base = normalizedPath.slice(0, normalizedPath.lastIndexOf("/"));
      return {
        path: normalizedPath,
        filePath: routePath,
        base,
        handlers: mod.handlers ?? mod.handler ?? null,
        config: mod.config ?? null,
        component: mod.default ?? null,
      } as InternalRoute<State>;
    }),
  );
  console.timeEnd("Load routes");

  routeModules.sort((a, b) => sortRoutePaths(a.path, b.path));

  const stack: InternalRoute<State>[] = [];
  let hasApp = false;

  for (let i = 0; i < routeModules.length; i++) {
    const routeMod = routeModules[i];
    const normalized = routeMod.path;

    let j = stack.length - 1;
    while (
      j >= 0 && stack[j].base !== "" &&
      !routeMod.path.startsWith(stack[j].base + "/")
    ) {
      j--;
      stack.pop();
    }

    if (normalized.endsWith("/_app")) {
      hasApp = true;
      stack.push(routeMod);
      continue;
    } else if (normalized.endsWith("/_middleware")) {
      stack.push(routeMod);
      continue;
    } else if (normalized.endsWith("/_layout")) {
      stack.push(routeMod);
      continue;
    } else if (normalized.endsWith("/_error")) {
      stack.push(routeMod);
      continue;
    } else if (normalized.endsWith("/_404")) {
      stack.push(routeMod);
      continue;
    } else if (normalized.endsWith("/_500")) {
      stack.push(routeMod);
      continue;
    }

    // Remove any elements not matching our parent path anymore
    const middlewares: MiddlewareFn<State>[] = [];
    let components: AnyComponent<PageProps<unknown, State>>[] = [];

    let skipApp = !!routeMod.config?.skipAppWrapper;
    const skipLayouts = !!routeMod.config?.skipInheritedLayouts;

    for (let k = 0; k < stack.length; k++) {
      const mod = stack[k];
      if (mod.path.endsWith("/_middleware")) {
        if (mod.handlers !== null && !isHandlerByMethod(mod.handlers)) {
          middlewares.push(mod.handlers as MiddlewareFn<State>);
        } else if (Array.isArray(mod.handlers)) {
          middlewares.push(...mod.handlers);
        }
      }

      // _app template
      if (skipApp && mod.path === "/_app") {
        hasApp = false;
        continue;
      } else if (!skipApp && mod.config?.skipAppWrapper) {
        skipApp = true;
        if (hasApp) {
          hasApp = false;
          // _app component is always first
          components.shift();
        }
      }

      // _layouts
      if (skipLayouts && mod.path.endsWith("/_layout")) {
        continue;
      } else if (!skipLayouts && mod.config?.skipInheritedLayouts) {
        const first = components.length > 0 ? components[0] : null;
        components = [];

        if (!skipApp && hasApp && first !== null) {
          components.push(first);
        }
      }

      if (mod.path.endsWith("/_error") || mod.path.endsWith("/_500")) {
        const handlers = mod.handlers;
        const handler = handlers === null ||
            (isHandlerByMethod(handlers) && Object.keys(handlers).length === 0)
          ? undefined
          : typeof handlers === "function"
          ? handlers
          : undefined; // FIXME: Method handler
        const errorComponents = components.slice();
        if (mod.component !== null) {
          errorComponents.push(mod.component);
        }
        let parent = mod.path.slice(0, -"_error".length);
        parent = parent === "/" ? "*" : parent + "*";
        app.all(
          parent,
          errorMiddleware(errorComponents, handler),
        );
        middlewares.push(errorMiddleware(errorComponents, handler));
        continue;
      }

      if (mod.path.endsWith("/_404")) {
        const handlers = mod.handlers;
        const handler = handlers === null ||
            (isHandlerByMethod(handlers) && Object.keys(handlers).length === 0)
          ? undefined
          : typeof handlers === "function"
          ? handlers
          : undefined; // FIXME: Method handler
        const notFoundComponents = components.slice();
        if (mod.component !== null) {
          notFoundComponents.push(mod.component);
        }
        app.use(notFoundMiddleware(notFoundComponents, handler));
        continue;
      }

      if (mod.component !== null) {
        components.push(mod.component);
      }
    }

    if (routeMod.component !== null) {
      components.push(routeMod.component);
    }

    const handlers = routeMod.handlers;
    const routePath = routeMod.config?.routeOverride ??
      pathToPattern(normalized.slice(1));

    if (
      handlers === null ||
      (isHandlerByMethod(handlers) && Object.keys(handlers).length === 0)
    ) {
      const combined = middlewares.concat(
        renderMiddleware(components, undefined),
      );
      app.get(routePath, ...combined);
    } else if (isHandlerByMethod(handlers)) {
      for (const method of Object.keys(handlers) as Method[]) {
        const fn = handlers[method];

        if (fn !== undefined) {
          const combined = middlewares.concat(renderMiddleware(components, fn));
          const lower = method.toLowerCase() as Lowercase<Method>;
          app[lower](routePath, ...combined);
        }
      }
    } else if (typeof handlers === "function") {
      const combined = middlewares.concat(
        renderMiddleware(components, handlers),
      );
      app.all(routePath, ...combined);
    }
  }
}

function errorMiddleware<State>(
  components: AnyComponent<PageProps<unknown, State>>[],
  handler: HandlerFn<unknown, State> | undefined,
): MiddlewareFn<State> {
  const mid = renderMiddleware<State>(components, handler);
  return async function errorMiddleware(ctx) {
    try {
      return await ctx.next();
    } catch (err) {
      ctx.error = err;
      return mid(ctx);
    }
  };
}

function notFoundMiddleware<State>(
  components: AnyComponent<PageProps<unknown, State>>[],
  handler: HandlerFn<unknown, State> | undefined,
): MiddlewareFn<State> {
  const mid = renderMiddleware<State>(components, handler);
  return async function notFoundMiddleware(ctx) {
    try {
      return await ctx.next();
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) {
        return mid(ctx);
      }
      throw err;
    }
  };
}

async function walkDir(
  dir: string,
  callback: (entry: WalkEntry) => void,
  ignore: RegExp[],
  fs: FsAdapter,
) {
  if (!await fs.isDirectory(dir)) return;

  const entries = fs.walk(dir, {
    includeDirs: false,
    includeFiles: true,
    exts: ["tsx", "jsx", "ts", "js"],
    skip: ignore,
  });

  for await (const entry of entries) {
    callback(entry);
  }
}

const APP_REG = /_app(?!\.[tj]sx?)?$/;

/**
 * Sort route paths where special Fresh files like `_app`,
 * `_layout` and `_middleware` are sorted in front.
 */
export function sortRoutePaths(a: string, b: string) {
  // The `_app` route should always be the first
  if (APP_REG.test(a)) return -1;
  else if (APP_REG.test(b)) return 1;

  let segmentIdx = 0;
  const aLen = a.length;
  const bLen = b.length;
  const maxLen = aLen > bLen ? aLen : bLen;
  for (let i = 0; i < maxLen; i++) {
    const charA = a.charAt(i);
    const charB = b.charAt(i);

    if (charA === "/" || charB === "/") {
      segmentIdx = i;

      // If the other path doesn't close the segment
      // then we don't need to continue
      if (charA !== "/") return 1;
      if (charB !== "/") return -1;

      continue;
    }

    if (i === segmentIdx + 1) {
      const scoreA = getRoutePathScore(charA, a, i);
      const scoreB = getRoutePathScore(charB, b, i);
      if (scoreA === scoreB) {
        if (charA !== charB) {
          // TODO: Do we need localeSort here or is this good enough?
          return charA < charB ? 0 : 1;
        }
        continue;
      }

      return scoreA > scoreB ? -1 : 1;
    }

    if (charA !== charB) {
      // TODO: Do we need localeSort here or is this good enough?
      return charA < charB ? 0 : 1;
    }
  }

  return 0;
}

/**
 * Assign a score based on the first two characters of a path segment.
 * The goal is to sort `_middleware` and `_layout` in front of everything
 * and `[` or `[...` last respectively.
 */
function getRoutePathScore(char: string, s: string, i: number): number {
  if (char === "_") {
    if (i + 1 < s.length) {
      if (s[i + 1] === "e") return 6;
      if (s[i + 1] === "m") return 5;
    }
    return 4;
  } else if (char === "[") {
    if (i + 1 < s.length && s[i + 1] === ".") {
      return 0;
    }
    return 1;
  }

  if (
    i + 4 === s.length - 1 && char === "i" && s[i + 1] === "n" &&
    s[i + 2] === "d" && s[i + 3] === "e" && s[i + 4] === "x"
  ) {
    return 3;
  }

  return 2;
}
