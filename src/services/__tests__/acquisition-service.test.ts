import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AcquisitionService } from '../acquisition-service.js';
import { BidStatus, type Bid, type PlaceBidInput } from '../../types/acquisition.js';
import { DuplicateDomainError } from '../../types/errors.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createMockRepo(): any {
  return {
    insert: vi.fn(),
    findPending: vi.fn(),
    findByDomain: vi.fn(),
    findByStatus: vi.fn(),
    findAll: vi.fn(),
    resolve: vi.fn(),
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
function createMockDb(): any {
  return {
    exec: vi.fn(),
    query: vi.fn(),
    queryOne: vi.fn(),
    transaction: vi.fn((fn: () => unknown) => fn()),
    close: vi.fn(),
    isOpen: vi.fn().mockReturnValue(true),
  };
}

function makeBid(overrides: Partial<Bid> = {}): Bid {
  return {
    id: 1,
    domain: 'example.com',
    venue: 'sedo',
    bidAmountEur: 100,
    maxBidEur: undefined,
    status: BidStatus.Pending,
    wonPriceEur: undefined,
    expectedValueAtBid: undefined,
    confidenceAtBid: undefined,
    suggestedBuyMaxAtBid: undefined,
    trademarkClearAtBid: undefined,
    bidPlacedAt: new Date().toISOString(),
    auctionEndsAt: undefined,
    resolvedAt: undefined,
    notes: undefined,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('AcquisitionService', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let repo: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pm: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let outcomeRepo: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  let svc: AcquisitionService;

  beforeEach(() => {
    repo = createMockRepo();
    pm = createMockPortfolioManager();
    outcomeRepo = createMockOutcomeRepo();
    db = createMockDb();
    svc = new AcquisitionService(repo, pm, outcomeRepo, db);
  });

  describe('place', () => {
    it('inserts a bid for a valid input', async () => {
      repo.findByDomain.mockReturnValue(null);
      repo.insert.mockReturnValue(makeBid());
      const input: PlaceBidInput = {
        domain: 'example.com',
        venue: 'sedo',
        bidAmountEur: 100,
      };
      const result = await svc.place(input);
      expect(result.domain).toBe('example.com');
      expect(repo.insert).toHaveBeenCalledWith(input);
    });

    it('rejects zero or negative bid amount', async () => {
      await expect(
        svc.place({
          domain: 'example.com',
          venue: 'sedo',
          bidAmountEur: 0,
        }),
      ).rejects.toThrow('Bid amount must be positive');

      await expect(
        svc.place({
          domain: 'example.com',
          venue: 'sedo',
          bidAmountEur: -50,
        }),
      ).rejects.toThrow('Bid amount must be positive');
    });

    it('rejects duplicate pending bid for the same domain', async () => {
      repo.findByDomain.mockReturnValue(makeBid({ status: BidStatus.Pending }));
      await expect(
        svc.place({
          domain: 'example.com',
          venue: 'godaddy',
          bidAmountEur: 200,
        }),
      ).rejects.toThrow(/already has a pending bid/);
    });

    it('allows new bid when previous bid is resolved (non-pending)', async () => {
      repo.findByDomain.mockReturnValue(makeBid({ status: BidStatus.Lost }));
      repo.insert.mockReturnValue(makeBid({ venue: 'godaddy', bidAmountEur: 200 }));
      const result = await svc.place({
        domain: 'example.com',
        venue: 'godaddy',
        bidAmountEur: 200,
      });
      expect(result.bidAmountEur).toBe(200);
    });
  });

  describe('resolve', () => {
    it('throws when no bid exists for the domain', async () => {
      repo.findByDomain.mockReturnValue(null);
      await expect(
        svc.resolve({
          domain: 'unknown.com',
          status: BidStatus.Lost,
        }),
      ).rejects.toThrow('No bid found');
    });

    it('throws when bid is already resolved', async () => {
      repo.findByDomain.mockReturnValue(
        makeBid({
          status: BidStatus.Won,
          resolvedAt: new Date().toISOString(),
        }),
      );
      await expect(
        svc.resolve({
          domain: 'example.com',
          status: BidStatus.Lost,
        }),
      ).rejects.toThrow(/already .+?\(resolved/);
    });

    it('resolves bid as Lost without creating portfolio entry', async () => {
      const pending = makeBid({ status: BidStatus.Pending });
      repo.findByDomain.mockReturnValue(pending);
      const resolvedBid = makeBid({ status: BidStatus.Lost, resolvedAt: new Date().toISOString() });
      repo.resolve.mockReturnValue(resolvedBid);

      const result = await svc.resolve({
        domain: 'example.com',
        status: BidStatus.Lost,
      });

      expect(result.status).toBe(BidStatus.Lost);
      expect(pm.add).not.toHaveBeenCalled();
      expect(outcomeRepo.insert).not.toHaveBeenCalled();
    });

    it('resolves bid as Cancelled without creating portfolio entry', async () => {
      const pending = makeBid({ status: BidStatus.Pending });
      repo.findByDomain.mockReturnValue(pending);
      repo.resolve.mockReturnValue(
        makeBid({ status: BidStatus.Cancelled, resolvedAt: new Date().toISOString() }),
      );

      const result = await svc.resolve({
        domain: 'example.com',
        status: BidStatus.Cancelled,
      });

      expect(result.status).toBe(BidStatus.Cancelled);
      expect(pm.add).not.toHaveBeenCalled();
      expect(outcomeRepo.insert).not.toHaveBeenCalled();
    });

    it('resolves bid as Won and creates portfolio + outcome', async () => {
      const pending = makeBid({
        status: BidStatus.Pending,
        bidAmountEur: 150,
        venue: 'godaddy',
      });
      repo.findByDomain.mockReturnValue(pending);
      const resolvedBid = makeBid({
        status: BidStatus.Won,
        resolvedAt: new Date().toISOString(),
        wonPriceEur: 150,
      });
      repo.resolve.mockReturnValue(resolvedBid);

      const result = await svc.resolve({
        domain: 'example.com',
        status: BidStatus.Won,
      });

      expect(result.status).toBe(BidStatus.Won);
      expect(pm.add).toHaveBeenCalledTimes(1);
      const addCall = pm.add.mock.calls[0]?.[0];
      expect(addCall?.domain).toBe('example.com');
      expect(addCall?.tld).toBe('.com');
      expect(addCall?.acquisitionCost).toBe(150);
      expect(addCall?.registrar).toBe('godaddy');
      expect(outcomeRepo.insert).toHaveBeenCalledTimes(1);
    });

    it('resolves bid as Won with custom price and registration period', async () => {
      const pending = makeBid({
        status: BidStatus.Pending,
        bidAmountEur: 150,
        venue: 'afternic',
      });
      repo.findByDomain.mockReturnValue(pending);
      repo.resolve.mockReturnValue(
        makeBid({
          status: BidStatus.Won,
          resolvedAt: new Date().toISOString(),
          wonPriceEur: 130,
        }),
      );

      await svc.resolve({
        domain: 'example.com',
        status: BidStatus.Won,
        wonPriceEur: 130,
        registrationYears: 2,
      });

      const addCall = pm.add.mock.calls[0]?.[0];
      expect(addCall?.acquisitionCost).toBe(130);
      const renewalMs = new Date(addCall?.renewalDate).getTime();
      const acquiredMs = new Date(addCall?.acquiredAt).getTime();
      const diffYears = (renewalMs - acquiredMs) / (365.25 * 24 * 60 * 60 * 1000);
      expect(diffYears).toBeCloseTo(2, 0);
    });

    it('uses parseDomain for multi-part TLDs', async () => {
      const pending = makeBid({
        domain: 'example.co.uk',
        status: BidStatus.Pending,
        bidAmountEur: 100,
        venue: 'sedo',
      });
      repo.findByDomain.mockReturnValue(pending);
      repo.resolve.mockReturnValue(
        makeBid({
          domain: 'example.co.uk',
          status: BidStatus.Won,
          resolvedAt: new Date().toISOString(),
        }),
      );

      await svc.resolve({
        domain: 'example.co.uk',
        status: BidStatus.Won,
      });

      const addCall = pm.add.mock.calls[0]?.[0];
      expect(addCall?.tld).toBe('.co.uk');
    });

    it('throws user-friendly error when domain is already in portfolio', async () => {
      const pending = makeBid({ status: BidStatus.Pending, venue: 'sedo' });
      repo.findByDomain.mockReturnValue(pending);
      pm.add.mockRejectedValue(new DuplicateDomainError('example.com'));

      await expect(
        svc.resolve({
          domain: 'example.com',
          status: BidStatus.Won,
        }),
      ).rejects.toThrow(/already in the portfolio/);
    });
  });

  describe('list', () => {
    it('returns all bids when no status filter', async () => {
      repo.findAll.mockReturnValue([makeBid(), makeBid({ domain: 'test.io' })]);
      const result = await svc.list();
      expect(result).toHaveLength(2);
    });

    it('filters by status when provided', async () => {
      repo.findByStatus.mockReturnValue([makeBid({ status: BidStatus.Pending })]);
      const result = await svc.list(BidStatus.Pending);
      expect(result).toHaveLength(1);
      expect(result[0]?.status).toBe(BidStatus.Pending);
    });
  });

  describe('pending', () => {
    it('returns pending bids from the repository', async () => {
      repo.findPending.mockReturnValue([makeBid()]);
      const result = await svc.pending();
      expect(result).toHaveLength(1);
    });
  });

  describe('get', () => {
    it('returns the bid for the given domain', async () => {
      repo.findByDomain.mockReturnValue(makeBid());
      const result = await svc.get('example.com');
      expect(result?.domain).toBe('example.com');
    });

    it('returns null when no bid exists', async () => {
      repo.findByDomain.mockReturnValue(null);
      const result = await svc.get('unknown.com');
      expect(result).toBeNull();
    });
  });
});
