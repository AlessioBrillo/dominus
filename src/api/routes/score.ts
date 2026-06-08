import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { ScoringEngine } from '../../scoring/scoring-engine.js';
import type { TrademarkGate } from '../../trademark/trademark-gate.js';
import { isValidDomain, parseDomain } from '../../utils/domain.js';
import { getRouteParam } from '../route-utils.js';

export function createScoreRouter(engine: ScoringEngine, gate?: TrademarkGate): Router {
  const router = Router();

  router.get('/:domain', (req: Request, res: Response, next: NextFunction): void => {
    const domain = getRouteParam(req, 'domain');
    if (domain === undefined || !isValidDomain(domain)) {
      res.status(400).json({
        error: { code: 'INVALID_DOMAIN', message: `'${domain ?? ''}' is not a valid domain` },
      });
      return;
    }

    const closeout = req.query['closeout'] === 'true';
    const age = req.query['age'] !== undefined ? Number(req.query['age']) : undefined;
    const backlinks =
      req.query['backlinks'] !== undefined ? Number(req.query['backlinks']) : undefined;
    const wayback = req.query['wayback'] !== undefined ? Number(req.query['wayback']) : undefined;

    const parsed = parseDomain(domain);

    engine
      .score({
        domain,
        tld: parsed.tld,
        sld: parsed.sld,
        isCloseout: closeout,
        domainAge: !isNaN(age!) ? age : undefined,
        backlinks: !isNaN(backlinks!) ? backlinks : undefined,
        waybackSnapshots: !isNaN(wayback!) ? wayback : undefined,
      })
      .then(async (scoreResult) => {
        let trademark: Record<string, unknown> | undefined;

        if (gate !== undefined) {
          try {
            const gateResult = await gate.check(domain);
            trademark = {
              verdict: gateResult.verdict,
              verifiedSources: gateResult.verifiedSources,
              ...(gateResult.matchedMark !== undefined
                ? { matchedMark: gateResult.matchedMark }
                : {}),
              ...(gateResult.matchedOwner !== undefined
                ? { matchedOwner: gateResult.matchedOwner }
                : {}),
              ...(gateResult.partial !== undefined ? { partial: gateResult.partial } : {}),
              ...(gateResult.usptoFailed !== undefined
                ? { usptoFailed: gateResult.usptoFailed }
                : {}),
            };
          } catch {
            trademark = { verdict: 'unverified', verifiedSources: [] };
          }
        }

        res.json({ domain, score: scoreResult, trademark });
      })
      .catch(next);
  });

  return router;
}
