// SPDX-License-Identifier: AGPL-3.0-only
import { cn } from '@/lib/utils';

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('animate-pulse rounded-md bg-bg-muted', className)} {...props} />;
}

export { Skeleton };
