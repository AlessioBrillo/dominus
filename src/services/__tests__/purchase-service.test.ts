import { describe, it, expect, vi } from 'vitest';
import { PurchaseService, AutoApprovalPolicy } from '../purchase-service.js';
import { GateVerdict } from '../../trademark/trademark-gate.js';
import { PurchaseNotApprovedError } from '../../types/registrar.js';
import type { RegistrarPriceCheck } from '../../providers/registrar/registrar-provider.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createMockRegistrar(): any {
  return {
    name: 'test-registrar',
    checkPrice: vi.fn(),
    purchase: vi.fn(),
    listDomains: vi.fn(),
    getRenewalCost: vi.fn(),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createMockPortfolioManager(): any {
  return { add: vi.fn() };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createMockOutcomeRepo(): any {
  return { insert: vi.fn() };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createMockEngine(): any {
  return { score: vi.fn() };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createMockGate(): any {
  return { check: vi.fn() };
}

function makePriceCheck(overrides: Partial<RegistrarPriceCheck> = {}): RegistrarPriceCheck {
  return {
    domain: 'example.com',
    available: true,
    registerPriceEur: 10,
    renewalPriceEur: 10,
    transferPriceEur: 10,
    checkedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('PurchaseService', () => {
  describe('constructor', () => {
    it('sets registrarName from registrar', () => {
      const reg = createMockRegistrar();
      const svc = new PurchaseService({
        registrar: reg,
        portfolioManager: createMockPortfolioManager(),
        outcomeRepo: createMockOutcomeRepo(),
      });
      expect(svc.registrarName).toBe('test-registrar');
    });

    it('defaults autoApproval to Never', () => {
      const svc = new PurchaseService({
        registrar: createMockRegistrar(),
        portfolioManager: createMockPortfolioManager(),
        outcomeRepo: createMockOutcomeRepo(),
      });
      expect(svc).toBeDefined();
    });

    it('defaults buyMaxAbsoluteCap to 500', () => {
      const svc = new PurchaseService({
        registrar: createMockRegistrar(),
        portfolioManager: createMockPortfolioManager(),
        outcomeRepo: createMockOutcomeRepo(),
      });
      expect(svc).toBeDefined();
    });
  });

  describe('preflight', () => {
    it('returns unavailable when registrar returns no price', async () => {
      const reg = createMockRegistrar();
      reg.checkPrice.mockResolvedValue([]);
      const svc = new PurchaseService({
        registrar: reg,
        portfolioManager: createMockPortfolioManager(),
        outcomeRepo: createMockOutcomeRepo(),
      });

      const result = await svc.preflight('example.com');
      expect(result.available).toBe(false);
      expect(result.registerPriceEur).toBeNull();
      expect(result.operatorApprovalRequired).toBe(true);
    });

    it('returns price data when registrar has it', async () => {
      const reg = createMockRegistrar();
      reg.checkPrice.mockResolvedValue([makePriceCheck()]);
      const svc = new PurchaseService({
        registrar: reg,
        portfolioManager: createMockPortfolioManager(),
        outcomeRepo: createMockOutcomeRepo(),
      });

      const result = await svc.preflight('example.com');
      expect(result.available).toBe(true);
      expect(result.registerPriceEur).toBe(10);
      expect(result.renewalPriceEur).toBe(10);
    });

    it('includes scoring data when engine is provided', async () => {
      const reg = createMockRegistrar();
      reg.checkPrice.mockResolvedValue([makePriceCheck()]);
      const engine = createMockEngine();
      engine.score.mockResolvedValue({
        domain: 'example.com',
        tld: 'com',
        sld: 'example',
        expectedValue: 500,
        confidence: 0.7,
        suggestedBuyMax: 250,
        suggestedListPrice: 1250,
        signals: [],
      });
      const svc = new PurchaseService({
        registrar: reg,
        portfolioManager: createMockPortfolioManager(),
        outcomeRepo: createMockOutcomeRepo(),
        engine,
      });

      const result = await svc.preflight('example.com');
      expect(result.expectedValue).toBe(500);
      expect(result.confidence).toBe(0.7);
      expect(result.suggestedBuyMax).toBe(250);
    });

    it('sets expectedValue to null when engine score throws', async () => {
      const reg = createMockRegistrar();
      reg.checkPrice.mockResolvedValue([makePriceCheck()]);
      const engine = createMockEngine();
      engine.score.mockRejectedValue(new Error('engine failed'));
      const svc = new PurchaseService({
        registrar: reg,
        portfolioManager: createMockPortfolioManager(),
        outcomeRepo: createMockOutcomeRepo(),
        engine,
      });

      const result = await svc.preflight('example.com');
      expect(result.expectedValue).toBeNull();
    });

    it('includes trademark data when gate is provided', async () => {
      const reg = createMockRegistrar();
      reg.checkPrice.mockResolvedValue([makePriceCheck()]);
      const gate = createMockGate();
      gate.check.mockResolvedValue({ verdict: GateVerdict.Clear });
      const svc = new PurchaseService({
        registrar: reg,
        portfolioManager: createMockPortfolioManager(),
        outcomeRepo: createMockOutcomeRepo(),
        gate,
      });

      const result = await svc.preflight('example.com');
      expect(result.trademarkClear).toBe(true);
    });

    it('sets trademarkClear to false when gate throws', async () => {
      const reg = createMockRegistrar();
      reg.checkPrice.mockResolvedValue([makePriceCheck()]);
      const gate = createMockGate();
      gate.check.mockRejectedValue(new Error('gate failed'));
      const svc = new PurchaseService({
        registrar: reg,
        portfolioManager: createMockPortfolioManager(),
        outcomeRepo: createMockOutcomeRepo(),
        gate,
      });

      const result = await svc.preflight('example.com');
      expect(result.trademarkClear).toBe(false);
    });

    it('sets operatorApprovalRequired based on policy', async () => {
      const reg = createMockRegistrar();
      reg.checkPrice.mockResolvedValue([makePriceCheck({ registerPriceEur: 100 })]);
      const engine = createMockEngine();
      engine.score.mockResolvedValue({
        domain: 'example.com',
        tld: 'com',
        sld: 'example',
        expectedValue: 500,
        confidence: 0.7,
        suggestedBuyMax: 250,
        suggestedListPrice: 1250,
        signals: [],
      });

      const svc = new PurchaseService({
        registrar: reg,
        portfolioManager: createMockPortfolioManager(),
        outcomeRepo: createMockOutcomeRepo(),
        engine,
        autoApproval: AutoApprovalPolicy.UnderBuyMax,
      });

      const result = await svc.preflight('example.com');
      expect(result.operatorApprovalRequired).toBe(false);
    });

    it('requires operator approval when cost exceeds buyMax', async () => {
      const reg = createMockRegistrar();
      reg.checkPrice.mockResolvedValue([makePriceCheck({ registerPriceEur: 500 })]);
      const engine = createMockEngine();
      engine.score.mockResolvedValue({
        domain: 'example.com',
        tld: 'com',
        sld: 'example',
        expectedValue: 500,
        confidence: 0.7,
        suggestedBuyMax: 250,
        suggestedListPrice: 1250,
        signals: [],
      });

      const svc = new PurchaseService({
        registrar: reg,
        portfolioManager: createMockPortfolioManager(),
        outcomeRepo: createMockOutcomeRepo(),
        engine,
        autoApproval: AutoApprovalPolicy.UnderBuyMax,
      });

      const result = await svc.preflight('example.com');
      expect(result.operatorApprovalRequired).toBe(true);
    });

    it('never requires operator approval under Always policy', async () => {
      const reg = createMockRegistrar();
      reg.checkPrice.mockResolvedValue([makePriceCheck({ registerPriceEur: 999 })]);
      const svc = new PurchaseService({
        registrar: reg,
        portfolioManager: createMockPortfolioManager(),
        outcomeRepo: createMockOutcomeRepo(),
        autoApproval: AutoApprovalPolicy.Always,
      });

      const result = await svc.preflight('example.com');
      expect(result.operatorApprovalRequired).toBe(false);
    });
  });

  describe('execute', () => {
    it('records purchase via manual registrar', async () => {
      const reg = createMockRegistrar();
      reg.name = 'manual';
      reg.checkPrice.mockResolvedValue([
        makePriceCheck({ available: false, registerPriceEur: null }),
      ]);
      const pm = createMockPortfolioManager();
      const outcomeRepo = createMockOutcomeRepo();
      const svc = new PurchaseService({
        registrar: reg,
        portfolioManager: pm,
        outcomeRepo,
      });

      const result = await svc.execute('example.com');
      expect(result.success).toBe(true);
      expect(result.message).toMatch(/portfolio update-costs/);
      expect(pm.add).toHaveBeenCalledTimes(1);
      expect(pm.add.mock.calls[0]?.[0]?.domain).toBe('example.com');
      expect(outcomeRepo.insert).toHaveBeenCalledTimes(1);
      expect(outcomeRepo.insert.mock.calls[0]?.[0]?.type).toBe('purchased');
    });

    it('rejects unavailable domains', async () => {
      const reg = createMockRegistrar();
      reg.checkPrice.mockResolvedValue([
        makePriceCheck({ available: false, registerPriceEur: null }),
      ]);
      const svc = new PurchaseService({
        registrar: reg,
        portfolioManager: createMockPortfolioManager(),
        outcomeRepo: createMockOutcomeRepo(),
      });

      const result = await svc.execute('example.com');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not available');
    });

    it('throws PurchaseNotApprovedError when operator approval needed', async () => {
      const reg = createMockRegistrar();
      reg.checkPrice.mockResolvedValue([makePriceCheck()]);
      const svc = new PurchaseService({
        registrar: reg,
        portfolioManager: createMockPortfolioManager(),
        outcomeRepo: createMockOutcomeRepo(),
        autoApproval: AutoApprovalPolicy.Never,
      });

      await expect(svc.execute('example.com')).rejects.toThrow(PurchaseNotApprovedError);
    });

    it('executes purchase, adds to portfolio, records outcome', async () => {
      const reg = createMockRegistrar();
      reg.checkPrice.mockResolvedValue([makePriceCheck()]);
      reg.purchase.mockResolvedValue({
        domain: 'example.com',
        success: true,
        priceEur: 10,
        renewalPriceEur: 10,
        orderId: 'ord-123',
        message: 'Registered!',
      });
      const pm = createMockPortfolioManager();
      const outcomeRepo = createMockOutcomeRepo();
      const svc = new PurchaseService({
        registrar: reg,
        portfolioManager: pm,
        outcomeRepo,
        autoApproval: AutoApprovalPolicy.Always,
      });

      const result = await svc.execute('example.com', 1, true);

      expect(result.success).toBe(true);
      expect(result.purchase?.domain).toBe('example.com');
      expect(result.purchase?.orderId).toBe('ord-123');
      expect(result.purchase?.priceEur).toBe(10);
      expect(pm.add).toHaveBeenCalledTimes(1);
      expect(pm.add.mock.calls[0]?.[0]?.domain).toBe('example.com');
      expect(outcomeRepo.insert).toHaveBeenCalledTimes(1);
      expect(outcomeRepo.insert.mock.calls[0]?.[0]?.type).toBe('purchased');
    });

    it('returns error when purchase fails at registrar', async () => {
      const reg = createMockRegistrar();
      reg.checkPrice.mockResolvedValue([makePriceCheck()]);
      reg.purchase.mockResolvedValue({
        domain: 'example.com',
        success: false,
        priceEur: 0,
        renewalPriceEur: 0,
        error: 'Insufficient funds',
      });
      const svc = new PurchaseService({
        registrar: reg,
        portfolioManager: createMockPortfolioManager(),
        outcomeRepo: createMockOutcomeRepo(),
        autoApproval: AutoApprovalPolicy.Always,
      });

      const result = await svc.execute('example.com', 1, true);
      expect(result.success).toBe(false);
      expect(result.error).toBe('Insufficient funds');
    });

    it('wraps unknown errors in result', async () => {
      const reg = createMockRegistrar();
      reg.checkPrice.mockImplementation(() => {
        throw new Error('unexpected crash');
      });
      const svc = new PurchaseService({
        registrar: reg,
        portfolioManager: createMockPortfolioManager(),
        outcomeRepo: createMockOutcomeRepo(),
        autoApproval: AutoApprovalPolicy.Always,
      });

      const result = await svc.execute('example.com');
      expect(result.success).toBe(false);
      expect(result.error).toBe('unexpected crash');
    });

    it('re-throws PurchaseNotApprovedError', async () => {
      const reg = createMockRegistrar();
      reg.checkPrice.mockImplementation(() => {
        throw new PurchaseNotApprovedError('example.com', 'test');
      });
      const svc = new PurchaseService({
        registrar: reg,
        portfolioManager: createMockPortfolioManager(),
        outcomeRepo: createMockOutcomeRepo(),
      });

      await expect(svc.execute('example.com')).rejects.toThrow(PurchaseNotApprovedError);
    });
  });

  describe('checkPrice', () => {
    it('delegates to registrar', async () => {
      const reg = createMockRegistrar();
      reg.checkPrice.mockResolvedValue([makePriceCheck()]);
      const svc = new PurchaseService({
        registrar: reg,
        portfolioManager: createMockPortfolioManager(),
        outcomeRepo: createMockOutcomeRepo(),
      });

      const result = await svc.checkPrice(['example.com']);
      expect(result).toHaveLength(1);
      expect(reg.checkPrice).toHaveBeenCalledWith(['example.com']);
    });
  });

  describe('listManagedDomains', () => {
    it('delegates to registrar listDomains', async () => {
      const reg = createMockRegistrar();
      reg.listDomains.mockResolvedValue([
        {
          domain: 'foo.com',
          registrar: 'test',
          expiryDate: '2027-01-01',
          autoRenew: true,
          locked: false,
          nameServers: [],
        },
      ]);
      const svc = new PurchaseService({
        registrar: reg,
        portfolioManager: createMockPortfolioManager(),
        outcomeRepo: createMockOutcomeRepo(),
      });

      const result = await svc.listManagedDomains();
      expect(result).toHaveLength(1);
      expect(result[0]?.domain).toBe('foo.com');
      expect(result[0]?.autoRenew).toBe(true);
    });

    it('returns empty array on error', async () => {
      const reg = createMockRegistrar();
      reg.listDomains.mockRejectedValue(new Error('API down'));
      const svc = new PurchaseService({
        registrar: reg,
        portfolioManager: createMockPortfolioManager(),
        outcomeRepo: createMockOutcomeRepo(),
      });

      const result = await svc.listManagedDomains();
      expect(result).toEqual([]);
    });
  });
});
