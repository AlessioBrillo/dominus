import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { DatabaseProvider } from '../../db/provider/interface.js';
import type { ScoringEngine } from '../../scoring/scoring-engine.js';
import { GateVerdict, type TrademarkGate } from '../../trademark/trademark-gate.js';
import type { PortfolioManager } from '../../portfolio/portfolio-manager.js';
import { parseDomain, isValidDomain } from '../../utils/domain.js';
import { getLogger } from '../../logger.js';

const logger = getLogger();

const SAMPLE_DOMAINS = [
  {
    domain: 'vintagecoffee.com',
    tld: '.com',
    sld: 'vintagecoffee',
    age: 14,
    backlinks: 420,
    wayback: 180,
  },
  { domain: 'oldmaproom.net', tld: '.net', sld: 'oldmaproom', age: 9, backlinks: 75, wayback: 40 },
  {
    domain: 'greenharvest.io',
    tld: '.io',
    sld: 'greenharvest',
    age: 6,
    backlinks: 210,
    wayback: 95,
  },
] as const;

const portfolioImportSchema = z.object({
  domains: z
    .array(
      z.object({
        domain: z.string().min(1).max(255),
        tld: z.string().min(1).max(255),
        acquiredAt: z.string().min(1),
        renewalDate: z.string().min(1),
        acquisitionCost: z.number().nonnegative().default(0),
        renewalCost: z.number().nonnegative().default(0),
        registrar: z.string().min(1).default('manual'),
      }),
    )
    .min(1)
    .max(500),
});

const wizardStateSchema = z.object({
  currentStep: z.string().min(1).max(50),
  stepData: z.record(z.string(), z.unknown()).optional(),
});

export function createOnboardingRouter(
  db: DatabaseProvider,
  engine: ScoringEngine,
  trademarkGate: TrademarkGate | undefined,
  portfolioManager: PortfolioManager,
): Router {
  const router = Router();

  router.post(
    '/sample-run',
    async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const results = await Promise.all(
          SAMPLE_DOMAINS.map(async (d) => {
            const score = await engine.score({
              domain: d.domain,
              tld: d.tld,
              sld: d.sld,
              isCloseout: true,
              domainAge: d.age,
              backlinks: d.backlinks,
              waybackSnapshots: d.wayback,
            });

            let trademark: Record<string, unknown> | null = null;
            if (trademarkGate) {
              try {
                const gateResult = await trademarkGate.check(d.domain);
                trademark = {
                  verdict: gateResult.verdict,
                  verifiedSources: gateResult.verifiedSources,
                };
              } catch {
                trademark = { verdict: 'unverified', verifiedSources: [] };
              }
            }

            return { domain: d.domain, score, trademark };
          }),
        );

        await db.exec("INSERT INTO events (tenant_id, type, props) VALUES ('default', ?, ?)", [
          'sample_run_viewed',
          JSON.stringify({ sampleCount: SAMPLE_DOMAINS.length }),
        ]);

        res.json({ results, sampleCount: SAMPLE_DOMAINS.length });
      } catch (err: unknown) {
        next(err);
      }
    },
  );

  /**
   * POST /portfolio/import — Import domains into the portfolio, score them,
   * and return verdicts with annual savings calculation.
   */
  router.post(
    '/portfolio/import',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const parsed = portfolioImportSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Invalid portfolio import payload',
              issues: parsed.error.issues,
            },
          });
          return;
        }

        const { domains } = parsed.data;
        const verdicts: Array<{
          domain: string;
          verdict: string;
          weightedScore: number;
          expectedValue: number;
          confidence: number;
          suggestedBuyMax: number;
          suggestedListPrice: number;
          trademarkClear: boolean;
          renewalCost: number;
        }> = [];
        let keep = 0;
        let drop = 0;
        let reprice = 0;
        let totalAnnualSavings = 0;
        const errors: Array<{ domain: string; error: string }> = [];

        for (const item of domains) {
          if (!isValidDomain(item.domain)) {
            errors.push({ domain: item.domain, error: 'Invalid domain format' });
            continue;
          }

          try {
            const parsedDomain = parseDomain(item.domain);
            const scoreResult = await engine.score({
              domain: item.domain,
              tld: parsedDomain.tld,
              sld: parsedDomain.sld,
              isCloseout: false,
            });

            const entry = await portfolioManager.add({
              domain: item.domain,
              tld: item.tld,
              acquiredAt: item.acquiredAt,
              renewalDate: item.renewalDate,
              acquisitionCost: item.acquisitionCost,
              renewalCost: item.renewalCost,
              registrar: item.registrar,
            });

            let trademarkClear = true;
            if (trademarkGate) {
              try {
                const gateResult = await trademarkGate.check(item.domain);
                trademarkClear = gateResult.verdict === GateVerdict.Clear;
              } catch {
                trademarkClear = false;
              }
            }

            const verdict = scoreResult.recommended ? 'keep' : entry.verdict;

            if (verdict === 'drop') {
              drop++;
              totalAnnualSavings += item.renewalCost;
            } else if (verdict === 'reprice') {
              reprice++;
            } else {
              keep++;
            }

            verdicts.push({
              domain: item.domain,
              verdict,
              weightedScore: scoreResult.weightedScore,
              expectedValue: scoreResult.expectedValue,
              confidence: scoreResult.confidence,
              suggestedBuyMax: scoreResult.suggestedBuyMax,
              suggestedListPrice: scoreResult.suggestedListPrice,
              trademarkClear,
              renewalCost: item.renewalCost,
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logger.warn({ domain: item.domain, err }, 'Portfolio import failed for domain');
            errors.push({ domain: item.domain, error: message });
          }
        }

        await db.exec("INSERT INTO events (tenant_id, type, props) VALUES ('default', ?, ?)", [
          'portfolio_imported',
          JSON.stringify({ imported: domains.length, errors: errors.length }),
        ]);

        res.status(201).json({
          imported: verdicts.length,
          errors: errors.length > 0 ? errors : undefined,
          verdicts,
          summary: {
            keep,
            drop,
            reprice,
            annualSavingsEur: totalAnnualSavings,
          },
        });
      } catch (err: unknown) {
        next(err);
      }
    },
  );

  /**
   * GET /state — Get the current onboarding wizard state.
   */
  router.get('/state', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const row = await db.queryOne<{
        current_step: string;
        step_data: string | null;
        completed_at: string | null;
      }>(
        "SELECT current_step, step_data, completed_at FROM onboarding_state WHERE tenant_id = 'default'",
      );

      if (!row) {
        res.json({ currentStep: 'welcome', stepData: null, completedAt: null });
        return;
      }

      res.json({
        currentStep: row.current_step,
        stepData: row.step_data ? JSON.parse(row.step_data) : null,
        completedAt: row.completed_at,
      });
    } catch (err: unknown) {
      next(err);
    }
  });

  /**
   * PATCH /state — Update the onboarding wizard state.
   */
  router.patch('/state', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = wizardStateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid wizard state payload',
            issues: parsed.error.issues,
          },
        });
        return;
      }

      const { currentStep, stepData } = parsed.data;
      await db.exec(
        `INSERT INTO onboarding_state (tenant_id, current_step, step_data, updated_at)
         VALUES ('default', ?, ?, datetime('now'))
         ON CONFLICT(tenant_id) DO UPDATE SET
           current_step = excluded.current_step,
           step_data = excluded.step_data,
           updated_at = datetime('now')`,
        [currentStep, stepData ? JSON.stringify(stepData) : null],
      );

      if (currentStep === 'complete') {
        await db.exec(
          "UPDATE onboarding_state SET completed_at = datetime('now'), updated_at = datetime('now') WHERE tenant_id = 'default'",
        );
        await db.exec("INSERT INTO events (tenant_id, type, props) VALUES ('default', ?, ?)", [
          'onboarding_completed',
          JSON.stringify({}),
        ]);
      }

      res.json({ currentStep, saved: true });
    } catch (err: unknown) {
      next(err);
    }
  });

  return router;
}
