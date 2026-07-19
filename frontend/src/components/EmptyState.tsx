import type { ReactNode } from 'react';
import { Card, CardContent } from '@/components/ui/card';

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center py-12">
        {icon && <div className="text-text-muted mb-4">{icon}</div>}
        <p className="text-text-primary text-sm font-medium mb-1">{title}</p>
        {description && <p className="text-text-muted text-xs mb-4">{description}</p>}
        {action}
      </CardContent>
    </Card>
  );
}
