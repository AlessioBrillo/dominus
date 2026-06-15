import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client.js';
import { placeBid, resolveBid } from '../api/bids.js';
import type { Bid } from '../types/domain.js';

function statusIcon(status: string): string {
  switch (status) {
    case 'pending':
      return '\u23F3';
    case 'won':
      return '\u2713';
    case 'lost':
      return '\u2717';
    case 'outbid':
      return '\u2191';
    case 'cancelled':
      return '\u2716';
    default:
      return '?';
  }
}

function statusClass(status: string): string {
  switch (status) {
    case 'pending':
      return 'bg-yellow-900/50 text-yellow-400';
    case 'won':
      return 'bg-emerald-900/50 text-emerald-400';
    case 'lost':
      return 'bg-red-900/50 text-red-400';
    case 'outbid':
      return 'bg-orange-900/50 text-orange-400';
    case 'cancelled':
      return 'bg-gray-800 text-gray-500';
    default:
      return 'bg-gray-800 text-gray-500';
  }
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: string }) {
  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
      <div className="text-xs text-gray-500 uppercase tracking-wider">{label}</div>
      <div className={`text-2xl font-bold mt-1 font-mono ${accent ?? 'text-gray-100'}`}>
        {value}
      </div>
    </div>
  );
}

function PlaceBidForm({ onPlaced }: { onPlaced: () => void }) {
  const [domain, setDomain] = useState('');
  const [amount, setAmount] = useState('');
  const [venue, setVenue] = useState('private');
  const [ends, setEnds] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const amt = Number.parseFloat(amount);
    if (!domain || Number.isNaN(amt) || amt <= 0) {
      setError('Domain and positive bid amount required');
      return;
    }
    setSubmitting(true);
    try {
      await placeBid({
        domain: domain.trim(),
        venue,
        bidAmountEur: amt,
        auctionEndsAt: ends || undefined,
      });
      setDomain('');
      setAmount('');
      setVenue('private');
      setEnds('');
      onPlaced();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to place bid');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-gray-900 rounded-xl border border-gray-800 p-4 space-y-3"
    >
      <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">Place Bid</h3>
      <div className="grid grid-cols-5 gap-3">
        <input
          type="text"
          placeholder="example.com"
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          className="col-span-2 bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-cyan-700"
        />
        <input
          type="number"
          step="0.01"
          min="0.01"
          placeholder="Amount (€)"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-cyan-700"
        />
        <select
          value={venue}
          onChange={(e) => setVenue(e.target.value)}
          className="bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-cyan-700"
        >
          <option value="private">Private</option>
          <option value="godaddy">GoDaddy</option>
          <option value="sedo">Sedo</option>
          <option value="afternic">Afternic</option>
          <option value="namecheap">Namecheap</option>
        </select>
        <input
          type="date"
          value={ends}
          onChange={(e) => setEnds(e.target.value)}
          className="bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-cyan-700"
        />
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      <button
        type="submit"
        disabled={submitting}
        className="px-4 py-1.5 bg-cyan-700 hover:bg-cyan-600 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
      >
        {submitting ? 'Placing...' : 'Place Bid'}
      </button>
    </form>
  );
}

function ResolveBidForm({ bid, onResolved }: { bid: Bid; onResolved: () => void }) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleResolve = useCallback(
    async (status: 'won' | 'lost' | 'cancelled' | 'outbid') => {
      setError(null);
      setSubmitting(true);
      try {
        await resolveBid({
          domain: bid.domain,
          status,
          registrationYears: 1,
        });
        onResolved();
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to resolve');
      } finally {
        setSubmitting(false);
      }
    },
    [bid.domain, onResolved],
  );

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={() => handleResolve('won')}
        disabled={submitting}
        className="px-2.5 py-1 bg-emerald-800 hover:bg-emerald-700 disabled:opacity-50 text-emerald-200 text-xs font-medium rounded transition-colors"
      >
        Won
      </button>
      <button
        onClick={() => handleResolve('lost')}
        disabled={submitting}
        className="px-2.5 py-1 bg-red-800 hover:bg-red-700 disabled:opacity-50 text-red-200 text-xs font-medium rounded transition-colors"
      >
        Lost
      </button>
      <button
        onClick={() => handleResolve('outbid')}
        disabled={submitting}
        className="px-2.5 py-1 bg-orange-800 hover:bg-orange-700 disabled:opacity-50 text-orange-200 text-xs font-medium rounded transition-colors"
      >
        Outbid
      </button>
      <button
        onClick={() => handleResolve('cancelled')}
        disabled={submitting}
        className="px-2.5 py-1 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-gray-300 text-xs font-medium rounded transition-colors"
      >
        Cancel
      </button>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </div>
  );
}

export function BidsPage() {
  const [bids, setBids] = useState<Bid[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const loadBids = useCallback(() => {
    setLoading(true);
    setError(null);
    api
      .get<{ bids: Bid[] }>(`/bids${filter ? `?status=${filter}` : ''}`)
      .then((data) => setBids(data.bids))
      .catch(() => setError('Failed to load bids'))
      .finally(() => setLoading(false));
  }, [filter]);

  useEffect(() => {
    loadBids();
  }, [loadBids]);

  const pending = bids.filter((b) => b.status === 'pending');
  const won = bids.filter((b) => b.status === 'won');
  const lost = bids.filter(
    (b) => b.status === 'lost' || b.status === 'cancelled' || b.status === 'outbid',
  );
  const totalSpent = won.reduce((s, b) => s + (b.wonPriceEur ?? b.bidAmountEur), 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-100">Bids &amp; Auctions</h2>
          <p className="text-sm text-gray-500 mt-1">
            {bids.length} total &middot; {pending.length} pending &middot; €{totalSpent.toFixed(2)}{' '}
            spent
          </p>
        </div>
      </div>

      <PlaceBidForm onPlaced={loadBids} />

      <div className="grid grid-cols-4 gap-4">
        <Stat label="Total" value={bids.length} />
        <Stat label="Pending" value={pending.length} accent="text-yellow-400" />
        <Stat label="Won" value={won.length} accent="text-emerald-400" />
        <Stat label="Lost/Outbid" value={lost.length} accent="text-red-400" />
      </div>

      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-500 uppercase tracking-wider">Filter:</span>
        {[undefined, 'pending', 'won', 'lost'].map((f) => (
          <button
            key={f ?? 'all'}
            onClick={() => setFilter(f)}
            className={`px-3 py-1 text-xs font-medium rounded-lg transition-colors ${
              filter === f
                ? 'bg-cyan-900/40 text-cyan-300'
                : 'bg-gray-800 text-gray-400 hover:text-gray-200'
            }`}
          >
            {f ?? 'All'}
          </button>
        ))}
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {loading ? (
        <div className="text-gray-500 animate-pulse">Loading bids...</div>
      ) : bids.length === 0 ? (
        <div className="text-gray-600 text-sm py-8 text-center">
          No bids found. Place your first bid above.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-800">
          <table className="w-full text-sm">
            <thead className="bg-gray-900">
              <tr className="text-left text-gray-500 text-xs uppercase">
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4">Domain</th>
                <th className="py-3 px-4">Amount</th>
                <th className="py-3 px-4">Venue</th>
                <th className="py-3 px-4">Placed</th>
                <th className="py-3 px-4">Ends</th>
                <th className="py-3 px-4">Actions</th>
              </tr>
            </thead>
            <tbody className="bg-gray-950">
              {bids.map((b) => (
                <tr key={b.id} className="border-b border-gray-800">
                  <td className="py-3 px-4">
                    <span
                      className={`px-2 py-0.5 rounded text-xs font-medium ${statusClass(b.status)}`}
                    >
                      {statusIcon(b.status)} {b.status}
                    </span>
                  </td>
                  <td className="py-3 px-4 font-medium text-gray-200">{b.domain}</td>
                  <td className="py-3 px-4 font-mono text-gray-300">
                    €{b.bidAmountEur.toFixed(2)}
                    {b.wonPriceEur !== undefined && b.wonPriceEur !== b.bidAmountEur && (
                      <span className="text-emerald-500 ml-1">
                        (won: €{b.wonPriceEur.toFixed(2)})
                      </span>
                    )}
                  </td>
                  <td className="py-3 px-4 text-gray-400">{b.venue}</td>
                  <td className="py-3 px-4 text-gray-400">
                    {new Date(b.bidPlacedAt).toLocaleDateString()}
                  </td>
                  <td className="py-3 px-4 text-gray-500">
                    {b.auctionEndsAt ? new Date(b.auctionEndsAt).toLocaleDateString() : '\u2014'}
                  </td>
                  <td className="py-3 px-4">
                    {b.status === 'pending' ? (
                      <ResolveBidForm bid={b} onResolved={loadBids} />
                    ) : (
                      <span className="text-xs text-gray-600">
                        {b.resolvedAt ? new Date(b.resolvedAt).toLocaleDateString() : ''}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
