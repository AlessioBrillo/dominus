// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { Download, Trash2 } from 'lucide-react';
import { useMe } from '@/hooks/useMe';
import { useEraseTenant, useExportTenantData } from '@/hooks/useTenantData';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

/**
 * Data-subject rights in the product itself (GDPR art. 15 and 17).
 * A paying customer must not have to email support to obtain a copy or to
 * erase a workspace. The typed confirmation is the tenant id, which the API
 * checks before deleting anything.
 */
export function DataRightsCard() {
  const { me } = useMe();
  const tenantId = me?.tenantId ?? '';
  const [confirmation, setConfirmation] = useState('');
  const exportData = useExportTenantData();
  const erase = useEraseTenant();
  const matches = tenantId.length > 0 && confirmation === tenantId;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Your data</CardTitle>
        <CardDescription>
          A copy of everything this workspace holds, or its permanent erasure
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => exportData.mutate()}
            disabled={exportData.isPending}
          >
            <Download className="h-4 w-4 mr-2" />
            {exportData.isPending ? 'Preparing...' : 'Download my data (JSON)'}
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" className="text-danger">
                <Trash2 className="h-4 w-4 mr-2" />
                Erase my workspace
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Erase this workspace?</AlertDialogTitle>
                <AlertDialogDescription>
                  This removes every row of this workspace and cancels its subscription. It cannot
                  be undone. Type the workspace id to confirm:{' '}
                  <span className="font-mono text-text-primary">{tenantId || '—'}</span>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <div className="py-2">
                <Input
                  aria-label="Workspace id to confirm"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  placeholder={tenantId || 'workspace id'}
                />
              </div>
              <AlertDialogFooter>
                <AlertDialogCancel onClick={() => setConfirmation('')}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-danger hover:bg-danger/90"
                  disabled={!matches || erase.isPending}
                  onClick={() => erase.mutate(confirmation)}
                >
                  {erase.isPending ? 'Erasing...' : 'Erase everything'}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
        <p className="text-xs text-text-muted">
          Erasure removes live data immediately. Backups follow the retention window described in
          the privacy notice.
        </p>
      </CardContent>
    </Card>
  );
}
