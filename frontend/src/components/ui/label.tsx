// SPDX-License-Identifier: AGPL-3.0-only
import { forwardRef } from 'react';
import type { LabelHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export interface LabelProps extends LabelHTMLAttributes<HTMLLabelElement> {
  htmlFor?: string;
}

const Label = forwardRef<HTMLLabelElement, LabelProps>(({ className, htmlFor, ...props }, ref) => (
  <label
    ref={ref}
    htmlFor={htmlFor}
    className={cn('text-xs font-medium text-text-secondary mb-1 block', className)}
    {...props}
  />
));
Label.displayName = 'Label';

export { Label };
