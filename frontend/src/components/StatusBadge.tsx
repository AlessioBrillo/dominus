import { Badge } from '@/components/ui/badge';

const statusMap: Record<
  string,
  { variant: 'success' | 'warning' | 'danger' | 'info' | 'outline'; label: string }
> = {
  running: { variant: 'info', label: 'Running' },
  completed: { variant: 'success', label: 'Completed' },
  failed: { variant: 'danger', label: 'Failed' },
  cancelled: { variant: 'warning', label: 'Cancelled' },
  pending: { variant: 'outline', label: 'Pending' },
  keep: { variant: 'success', label: 'Keep' },
  drop: { variant: 'danger', label: 'Drop' },
  reprice: { variant: 'warning', label: 'Reprice' },
  sold: { variant: 'success', label: 'Sold' },
  expired: { variant: 'danger', label: 'Expired' },
  renewed: { variant: 'info', label: 'Renewed' },
  listed: { variant: 'success', label: 'Listed' },
  draft: { variant: 'outline', label: 'Draft' },
};

interface StatusBadgeProps {
  status: string;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const mapping = statusMap[status] ?? { variant: 'outline' as const, label: status };
  return <Badge variant={mapping.variant}>{mapping.label}</Badge>;
}
