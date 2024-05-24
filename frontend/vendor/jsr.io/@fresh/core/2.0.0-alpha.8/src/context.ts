import { type ComponentType, h, type VNode } from "npm:preact@^10.20.2";
import type { ResolvedFreshConfig } from "./config.ts";
import { renderToString } from "npm:preact-render-to-string@^6.4.2";
import type { BuildCache } from "./build_cache.ts";
import {
  FreshScripts,
  RenderState,
  setRenderState,
} from "./runtime/server/preact_hooks.tsx";
import { DEV_ERROR_OVERLAY_URL } from "./constants.ts";

export interface Island {
  file: string | URL;
  name: string;
  exportName: string;
  fn: ComponentType;
}

export type ServerIslandRegistry = Map<ComponentType, Island>;

/**
 * The context passed to every middleware. It is unique for every request.
 */
export interface FreshContext<Data = unknown, State = unknown> {
  /** Reference to the resolved Fresh configuration */
  readonly config: ResolvedFreshConfig;
  state: State;
  data: Data;
  /** The original incoming `Request` object` */
  req: Request;
  /**
   * The request url parsed into an `URL` instance. This is typically used
   * to apply logic based on the pathname of the incoming url or when
   * certain search parameters are set.
   */
  url: URL;
  params: Record<string, string>;
  error: unknown;
  info?: Deno.ServeHandlerInfo | Deno.ServeUnixHandlerInfo;
  /**
   * Return a redirect response to the specified path. This is the
   * preferred way to do redirects in Fresh.
   *
   * ```ts
   * ctx.redirect("/foo/bar") // redirect user to "<yoursite>/foo/bar"
   *
   * // Disallows protocol relative URLs for improved security. This
   * // redirects the user to `<yoursite>/evil.com` which is safe,
   * // instead of redirecting to `http://evil.com`.
   * ctx.redirect("//evil.com/");
   * ```
   */
  redirect(path: string, status?: number): Response;
  /**
   * Call the next middleware.
   * ```ts
   * const myMiddleware: Middleware = (ctx) => {
   *   // do something
   *
   *   // Call the next middleware
   *   return ctx.next();
   * }
   *
   * const myMiddleware2: Middleware = async (ctx) => {
   *   // do something before the next middleware
   *   doSomething()
   *
   *   const res = await ctx.next();
   *
   *   // do something after the middleware
   *   doSomethingAfter()
   *
   *   // Return the `Response`
   *   return res
   * }
   */
  next(): Promise<Response>;
  render(vnode: VNode, init?: ResponseInit): Response | Promise<Response>;
}

export let getBuildCache: (ctx: FreshContext<unknown, unknown>) => BuildCache;

export class FreshReqContext<State> implements FreshContext<unknown, State> {
  url: URL;
  params = {} as Record<string, string>;
  state = {} as State;
  data = {} as never;
  error: Error | null = null;
  #islandRegistry: ServerIslandRegistry;
  #buildCache: BuildCache;

  static {
    getBuildCache = (ctx) => (ctx as FreshReqContext<unknown>).#buildCache;
  }

  constructor(
    public req: Request,
    public config: ResolvedFreshConfig,
    public next: FreshContext<unknown, State>["next"],
    islandRegistry: ServerIslandRegistry,
    buildCache: BuildCache,
    public info?: Deno.ServeHandlerInfo | Deno.ServeUnixHandlerInfo,
  ) {
    this.#islandRegistry = islandRegistry;
    this.#buildCache = buildCache;
    this.url = new URL(req.url);
  }

  redirect(pathOrUrl: string, status = 302): Response {
    let location = pathOrUrl;

    // Disallow protocol relative URLs
    if (pathOrUrl !== "/" && pathOrUrl.startsWith("/")) {
      let idx = pathOrUrl.indexOf("?");
      if (idx === -1) {
        idx = pathOrUrl.indexOf("#");
      }

      const pathname = idx > -1 ? pathOrUrl.slice(0, idx) : pathOrUrl;
      const search = idx > -1 ? pathOrUrl.slice(idx) : "";

      // Remove double slashes to prevent open redirect vulnerability.
      location = `${pathname.replaceAll(/\/+/g, "/")}${search}`;
    }

    return new Response(null, {
      status,
      headers: {
        location,
      },
    });
  }

  render(
    // deno-lint-ignore no-explicit-any
    vnode: VNode<any>,
    init: ResponseInit | undefined = {},
  ): Response | Promise<Response> {
    const headers = init.headers !== undefined
      ? init.headers instanceof Headers
        ? init.headers
        : new Headers(init.headers)
      : new Headers();

    headers.set("Content-Type", "text/html; charset=utf-8");
    const responseInit: ResponseInit = { status: init.status ?? 200, headers };

    let partialId = "";
    if (this.url.searchParams.has("fresh-partial")) {
      partialId = crypto.randomUUID();
      headers.set("X-Fresh-Id", partialId);
    }

    const html = preactRender(
      vnode,
      this,
      this.#islandRegistry,
      this.#buildCache,
      partialId,
    );
    return new Response(html, responseInit);
  }
}

function preactRender<State, Data>(
  vnode: VNode,
  ctx: FreshContext<Data, State>,
  islandRegistry: ServerIslandRegistry,
  buildCache: BuildCache,
  partialId: string,
) {
  const state = new RenderState(ctx, islandRegistry, buildCache, partialId);
  setRenderState(state);
  try {
    let res = renderToString(vnode);
    // We require a the full outer DOM structure so that browser put
    // comment markers in the right place in the DOM.
    if (!state.renderedHtmlBody) {
      let scripts = "";
      if (ctx.url.pathname !== ctx.config.basePath + DEV_ERROR_OVERLAY_URL) {
        scripts = renderToString(h(FreshScripts, null));
      }
      res = `<body>${res}${scripts}</body>`;
    }
    if (!state.renderedHtmlHead) {
      res = `<head><meta charset="utf-8"></head>${res}`;
    }
    if (!state.renderedHtmlTag) {
      res = `<html>${res}</html>`;
    }

    return `<!DOCTYPE html>${res}`;
  } finally {
    state.clear();
    setRenderState(null);
  }
}
