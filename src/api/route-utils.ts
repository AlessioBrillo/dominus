// SPDX-License-Identifier: AGPL-3.0-only
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

/**
 * True when a caller-supplied URL belongs to the deployment's own origin.
 *
 * The checkout and the billing portal take a redirect target from the
 * client. A prefix comparison (`url.startsWith(appOrigin)`) accepts
 * `https://dominus.app.attacker.tld`, because the string starts with the
 * allowed origin: the customer would be sent to a lookalike host with the
 * session id in the query string. The comparison is therefore done on the
 * parsed origin, which is the only part that identifies the site.
 *
 * When no origin is configured the check is a no-op: the deployment has
 * not declared a canonical origin, so there is nothing to compare against.
 */
export function isAllowedAppUrl(candidate: string, appOrigin: string | undefined): boolean {
  if (appOrigin === undefined || appOrigin === '') return true;
  try {
    return new URL(candidate).origin === new URL(appOrigin).origin;
  } catch {
    return false;
  }
}
