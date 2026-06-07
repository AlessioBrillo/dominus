import type { Request } from 'express';

/**
 * Express 5's `ParamsDictionary` types each route parameter as
 * `string | string[]` (a wildcard param like `/files/*path` can be an
 * array; a regular `:id` param is a string). The previous `@types/express`
 * 4.x typed them all as `string`, so the codebase used `req.params['x']`
 * directly. With the upgrade the type is honest about both shapes.
 *
 * Use this helper instead of touching `req.params` directly. It collapses
 * the union to `string | undefined` so the rest of the handler can treat
 * the param as a plain string and return a 400 when it is missing or empty.
 */
export function getRouteParam(req: Request, key: string): string | undefined {
  const value = req.params[key];
  if (Array.isArray(value)) {
    return value.length > 0 ? value[0] : undefined;
  }
  return value;
}
