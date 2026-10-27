import { type Context, Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../auth/actor';
import type { Actor } from '../auth/permissions';
import type { AppContext } from '../context';
import { unauthorized } from './errors';

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface OpMeta<B extends z.ZodType | undefined, Q extends z.ZodType | undefined> {
  method: Method;
  path: string;
  summary: string;
  tags: string[];
  body?: B;
  query?: Q;
  /** Public endpoints don't require authentication. */
  public?: boolean;
  description?: string;
}

export interface OpArgs<B, Q> {
  c: Context<Env>;
  ctx: AppContext;
  actor: Actor;
  orgId: string;
  body: B;
  query: Q;
  params: Record<string, string>;
}

interface Registered {
  meta: OpMeta<z.ZodType | undefined, z.ZodType | undefined>;
}

/**
 * Thin registry around Hono: validates JSON bodies/queries with zod and records metadata so the
 * OpenAPI 3.1 document is generated from the same definitions the handlers use.
 */
export class Api {
  readonly app = new Hono<Env>();
  private ops: Registered[] = [];

  op<B extends z.ZodType | undefined = undefined, Q extends z.ZodType | undefined = undefined>(
    meta: OpMeta<B, Q>,
    handler: (
      args: OpArgs<
        B extends z.ZodType ? z.infer<B> : undefined,
        Q extends z.ZodType ? z.infer<Q> : undefined
      > & {
        actor: Actor;
      },
    ) => Promise<Response | unknown>,
  ) {
    this.ops.push({ meta: meta as OpMeta<z.ZodType | undefined, z.ZodType | undefined> });
    this.app.on(meta.method.toUpperCase(), meta.path, async (c) => {
      const actor = c.get('actor');
      if (!meta.public && !actor) throw unauthorized();
      const body = meta.body ? meta.body.parse(await c.req.json().catch(() => ({}))) : undefined;
      const query = meta.query ? meta.query.parse(c.req.query()) : undefined;
      const result = await handler({
        c,
        ctx: c.get('ctx'),
        actor: actor as Actor,
        orgId: c.get('orgId'),
        body: body as never,
        query: query as never,
        params: c.req.param() as Record<string, string>,
      });
      if (result instanceof Response) return result;
      if (result === undefined) return c.body(null, 204);
      return c.json(result as object);
    });
  }

  mount(prefix: string, other: Api) {
    this.app.route(prefix, other.app);
    for (const o of other.ops) this.ops.push({ meta: { ...o.meta, path: `${prefix}${o.meta.path}` } });
  }

  openapi(info: { title: string; version: string; serverUrl: string }) {
    const paths: Record<string, Record<string, unknown>> = {};
    const toJson = (s: z.ZodType) => {
      try {
        return z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' });
      } catch {
        return {};
      }
    };
    for (const { meta } of this.ops) {
      const path = meta.path.replace(/:([A-Za-z_]+)\{[^}]*\}/g, '{$1}').replace(/:([A-Za-z_]+)/g, '{$1}');
      const params = [...path.matchAll(/\{([A-Za-z_]+)\}/g)].map((m) => ({
        name: m[1],
        in: 'path',
        required: true,
        schema: { type: 'string' },
      }));
      if (meta.query) {
        const js = toJson(meta.query) as { properties?: Record<string, unknown>; required?: string[] };
        for (const [name, schema] of Object.entries(js.properties ?? {})) {
          params.push({ name, in: 'query', required: (js.required ?? []).includes(name), schema } as never);
        }
      }
      paths[path] ??= {};
      paths[path][meta.method] = {
        summary: meta.summary,
        description: meta.description,
        tags: meta.tags,
        parameters: params,
        security: meta.public ? [] : [{ bearer: [] }, { session: [] }],
        ...(meta.body
          ? {
              requestBody: { required: true, content: { 'application/json': { schema: toJson(meta.body) } } },
            }
          : {}),
        responses: {
          200: { description: 'OK' },
          401: { description: 'Unauthorized' },
          403: { description: 'Forbidden' },
        },
      };
    }
    return {
      openapi: '3.1.0',
      info: {
        title: info.title,
        version: info.version,
        description:
          'DojoHub REST API. Authenticate with a personal access token (`Authorization: Bearer dojo_pat_…`).',
      },
      servers: [{ url: info.serverUrl }],
      components: {
        securitySchemes: {
          bearer: { type: 'http', scheme: 'bearer', description: 'DojoHub personal access token' },
          session: { type: 'apiKey', in: 'cookie', name: 'dojohub.session_token' },
        },
      },
      paths,
    };
  }
}

export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
