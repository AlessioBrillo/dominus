import { useMemo, useState } from 'react';
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
import { ArrowUpDown, MoreVertical, RefreshCw, RotateCcw, Trash2, Eye } from 'lucide-react';
import {
  usePortfolioList,
  useRescorePortfolio,
  useRefreshVerdicts,
  useUpdateVerdict,
  useRemoveFromPortfolio,
} from '@/hooks/usePortfolio';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import type { PortfolioEntry } from '@/types/domain';

type RowData = PortfolioEntry;

function verdictVariant(v: string) {
  switch (v) {
    case 'keep':
      return 'success' as const;
    case 'reprice':
      return 'warning' as const;
    case 'drop':
      return 'danger' as const;
    default:
      return 'outline' as const;
  }
}

function daysUntilRenewal(renewalDate: string): number {
  const now = Date.now();
  const renewal = new Date(renewalDate).getTime();
  return Math.ceil((renewal - now) / 86400000);
}

export function PortfolioPage() {
  const { data: portfolio = [], isLoading, error } = usePortfolioList();
  const rescore = useRescorePortfolio();
  const verdicts = useRefreshVerdicts();
  const updateVerdict = useUpdateVerdict();
  const removeDomain = useRemoveFromPortfolio();
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [globalFilter, setGlobalFilter] = useState('');
  const [expandedDomain, setExpandedDomain] = useState<string | null>(null);

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
        cell: (info) => {
          const date = info.getValue();
          if (!date) return <span className="text-sm text-text-secondary">—</span>;
          const days = daysUntilRenewal(date);
          const soon = days <= 60;
          return (
            <span className={`text-sm font-mono ${soon ? 'text-danger' : 'text-text-secondary'}`}>
              {new Date(date).toLocaleDateString()}
              {soon && <span className="ml-1">⚠</span>}
            </span>
          );
        },
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
          return (
            <div className="flex items-center gap-2">
              <Badge variant={verdictVariant(v)}>{v}</Badge>
              {info.row.original.verdictReason && (
                <span
                  className="text-xs text-text-muted truncate max-w-32 cursor-help"
                  title={info.row.original.verdictReason}
                >
                  {info.row.original.verdictReason.length > 30
                    ? info.row.original.verdictReason.slice(0, 30) + '…'
                    : info.row.original.verdictReason}
                </span>
              )}
            </div>
          );
        },
      }),
      col.display({
        id: 'actions',
        header: '',
        cell: (info) => {
          const domain = info.row.original.domain;
          const isUpdating = updateVerdict.isPending && updateVerdict.variables?.domain === domain;
          return (
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => setExpandedDomain(expandedDomain === domain ? null : domain)}
              >
                <Eye className="h-3.5 w-3.5" />
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={isUpdating}>
                    <MoreVertical className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-36">
                  <DropdownMenuItem
                    onClick={() =>
                      updateVerdict.mutate({
                        domain,
                        input: { verdict: 'keep' },
                      })
                    }
                  >
                    Keep
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() =>
                      updateVerdict.mutate({
                        domain,
                        input: { verdict: 'reprice' },
                      })
                    }
                  >
                    Reprice
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() =>
                      updateVerdict.mutate({
                        domain,
                        input: { verdict: 'drop' },
                      })
                    }
                  >
                    Drop
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <DropdownMenuItem
                        className="text-danger"
                        onSelect={(e) => e.preventDefault()}
                      >
                        <Trash2 className="h-3.5 w-3.5 mr-2" />
                        Remove
                      </DropdownMenuItem>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Remove from portfolio?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This will permanently remove <strong>{domain}</strong> and all its
                          outcomes from your portfolio. This action cannot be undone.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => removeDomain.mutate(domain)}
                          className="bg-danger hover:bg-danger/90"
                        >
                          Remove
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
        },
      }),
    ];
  }, [expandedDomain, updateVerdict, removeDomain]);

  const table = useReactTable({
    data: portfolio,
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

  if (isLoading) {
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
            <p className="text-danger text-sm mb-4">
              {error instanceof Error ? error.message : 'Failed to load portfolio'}
            </p>
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
            onClick={() => rescore.mutate()}
            disabled={rescore.isPending}
          >
            <RefreshCw className="h-3 w-3 mr-1" />
            {rescore.isPending ? 'Rescoring...' : 'Rescore'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => verdicts.mutate()}
            disabled={verdicts.isPending}
          >
            <RotateCcw className="h-3 w-3 mr-1" />
            {verdicts.isPending ? 'Refreshing...' : 'Verdicts'}
          </Button>
        </div>
      </div>

      {portfolio.length === 0 ? (
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
                  <>
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
                    {expandedDomain === row.original.domain && (
                      <tr key={`${row.id}-detail`}>
                        <td
                          colSpan={columns.length}
                          className="bg-bg-muted/50 px-4 py-3 border-b border-border"
                        >
                          <div className="grid grid-cols-3 gap-4 text-sm">
                            <div>
                              <span className="text-text-muted text-xs uppercase tracking-wider block mb-1">
                                Details
                              </span>
                              <p className="text-text-secondary">TLD: {row.original.tld}</p>
                              <p className="text-text-secondary">
                                Registrar: {row.original.registrar}
                              </p>
                              <p className="text-text-secondary">
                                Acquired: {new Date(row.original.acquiredAt).toLocaleDateString()}
                              </p>
                              <p className="text-text-secondary">
                                Renewal cost: €{row.original.renewalCost?.toFixed(2) ?? '—'}
                                /yr
                              </p>
                            </div>
                            {row.original.verdictReason && (
                              <div className="col-span-2">
                                <span className="text-text-muted text-xs uppercase tracking-wider block mb-1">
                                  Verdict Reason
                                </span>
                                <p className="text-text-secondary whitespace-pre-wrap">
                                  {row.original.verdictReason}
                                </p>
                              </div>
                            )}
                            {row.original.notes && (
                              <div className="col-span-2">
                                <span className="text-text-muted text-xs uppercase tracking-wider block mb-1">
                                  Notes
                                </span>
                                <p className="text-text-secondary whitespace-pre-wrap">
                                  {row.original.notes}
                                </p>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between text-sm text-text-muted">
            <span>
              Showing {table.getRowModel().rows.length} of {portfolio.length} domains
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
