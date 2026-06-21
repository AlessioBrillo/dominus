import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  createColumnHelper,
  flexRender,
  type SortingState,
  type ColumnFiltersState,
} from '@tanstack/react-table';
import { ArrowUpDown, RefreshCw, RotateCcw } from 'lucide-react';
import {
  fetchPortfolio,
  rescorePortfolio,
  refreshVerdicts,
  type PortfolioListResponse,
} from '@/api/portfolio';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import type { PortfolioEntry } from '@/types/domain';

type RowData = PortfolioEntry;

export function PortfolioPage() {
  const [data, setData] = useState<RowData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [globalFilter, setGlobalFilter] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result: PortfolioListResponse = await fetchPortfolio();
      setData(result.portfolio);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load portfolio');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const columns = useMemo(() => {
    const col = createColumnHelper<RowData>();
    return [
      col.accessor('domain', {
        header: 'Domain',
        cell: (info) => (
          <span className="font-mono text-sm font-medium text-text-primary">{info.getValue()}</span>
        ),
      }),
      col.accessor('acquisitionCost', {
        header: 'Cost',
        cell: (info) => (
          <span className="font-mono text-sm text-text-secondary">
            €{info.getValue()?.toFixed(2) ?? '—'}
          </span>
        ),
      }),
      col.accessor('renewalDate', {
        header: 'Renewal',
        cell: (info) => (
          <span className="text-sm text-text-secondary">
            {info.getValue() ? new Date(info.getValue()!).toLocaleDateString() : '—'}
          </span>
        ),
      }),
      col.accessor('currentScore', {
        header: 'Score',
        cell: (info) => (
          <span className="font-mono text-sm text-text-primary">
            {info.getValue() != null ? `${(info.getValue()! * 100).toFixed(0)}` : '—'}
          </span>
        ),
      }),
      col.accessor('suggestedListPrice', {
        header: 'List Price',
        cell: (info) => (
          <span className="font-mono text-sm text-accent">
            {info.getValue() != null ? `€${info.getValue()!.toFixed(0)}` : '—'}
          </span>
        ),
      }),
      col.accessor('verdict', {
        header: 'Verdict',
        cell: (info) => {
          const v = info.getValue();
          const variant =
            v === 'keep'
              ? ('success' as const)
              : v === 'reprice'
                ? ('warning' as const)
                : ('danger' as const);
          return <Badge variant={variant}>{v}</Badge>;
        },
      }),
    ];
  }, []);

  const table = useReactTable({
    data,
    columns,
    state: { sorting, columnFilters, globalFilter },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: 25 } },
  });

  if (loading) {
    return (
      <div className="space-y-6">
        <h2 className="text-2xl font-bold text-text-primary">Portfolio</h2>
        <Card>
          <CardHeader>
            <Skeleton className="h-4 w-32" />
          </CardHeader>
          <CardContent className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <h2 className="text-2xl font-bold text-text-primary">Portfolio</h2>
        <Card>
          <CardContent className="flex flex-col items-center py-8">
            <p className="text-danger text-sm mb-4">{error}</p>
            <Button variant="outline" onClick={load}>
              <RefreshCw className="h-4 w-4 mr-2" />
              Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h2 className="text-2xl font-bold text-text-primary">Portfolio</h2>
        <div className="flex items-center gap-2">
          <Input
            placeholder="Search domains..."
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
            className="w-48 h-8 text-xs"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              await rescorePortfolio();
              load();
            }}
          >
            <RefreshCw className="h-3 w-3 mr-1" />
            Rescore
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              await refreshVerdicts();
              load();
            }}
          >
            <RotateCcw className="h-3 w-3 mr-1" />
            Verdicts
          </Button>
        </div>
      </div>

      {data.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-text-muted">
            No domains in portfolio. Use the CLI to add domains.
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="rounded-xl border border-border overflow-hidden">
            <table className="w-full">
              <thead>
                {table.getHeaderGroups().map((hg) => (
                  <tr key={hg.id} className="bg-bg-muted">
                    {hg.headers.map((header) => (
                      <th
                        key={header.id}
                        className="text-left py-3 px-4 text-xs font-medium text-text-muted uppercase tracking-wider cursor-pointer select-none hover:text-text-primary"
                        onClick={header.column.getToggleSortingHandler()}
                      >
                        <div className="flex items-center gap-1">
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          <ArrowUpDown className="h-3 w-3" />
                        </div>
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
              <tbody className="bg-bg-elevated">
                {table.getRowModel().rows.map((row) => (
                  <tr
                    key={row.id}
                    className="border-b border-border hover:bg-bg-hover transition-colors"
                  >
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className="py-3 px-4">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between text-sm text-text-muted">
            <span>
              Showing {table.getRowModel().rows.length} of {data.length} domains
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => table.previousPage()}
                disabled={!table.getCanPreviousPage()}
              >
                Previous
              </Button>
              <span className="text-xs">
                Page {table.getState().pagination.pageIndex + 1} of {table.getPageCount()}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => table.nextPage()}
                disabled={!table.getCanNextPage()}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
