import { describe, it, expect } from 'vitest';
import type { Request } from 'express';
import { getRouteParam } from '../route-utils.js';

function makeReq(params: Record<string, string | string[]>): Request {
  return { params } as unknown as Request;
}

describe('getRouteParam', () => {
  it('returns the string value when the param is a regular :id', () => {
    const req = makeReq({ domain: 'nike.com' });
    expect(getRouteParam(req, 'domain')).toBe('nike.com');
  });

  it('returns the first element when the param is a wildcard array', () => {
    const req = makeReq({ path: ['a', 'b', 'c'] });
    expect(getRouteParam(req, 'path')).toBe('a');
  });

  it('returns undefined when the param is missing', () => {
    const req = makeReq({});
    expect(getRouteParam(req, 'domain')).toBeUndefined();
  });

  it('returns undefined when the wildcard array is empty', () => {
    const req = makeReq({ path: [] });
    expect(getRouteParam(req, 'path')).toBeUndefined();
  });
});
