import { useState } from 'react';
import { ShoppingCart, X } from 'lucide-react';
import { ScoreGauge } from './ScoreGauge';
import { ShareButton } from './ShareButton';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type { Candidate } from '@/types/domain';

interface CandidateCardProps {
  candidate: Candidate;
  onBuy?: (domain: string) => void;
  onDismiss?: (domain: string) => void;
}

export function CandidateCard({ candidate, onBuy, onDismiss }: CandidateCardProps) {
  const [showBuyDialog, setShowBuyDialog] = useState(false);
  const score = candidate.scoreResult;

  const statusVariant =
    candidate.status === 'recommended'
      ? 'success'
      : candidate.status === 'scored'
        ? 'warning'
        : 'default';

  return (
    <>
      <Card className="hover:border-border-strong transition-colors">
        <CardHeader>
          <div className="flex items-start justify-between">
            <div>
              <h3 className="text-lg font-semibold text-text-primary font-mono">
                {candidate.domain}
              </h3>
              <Badge variant={statusVariant} className="mt-1">
                {candidate.status}
              </Badge>
            </div>
            {onDismiss && (
              <button
                onClick={() => onDismiss(candidate.domain)}
                className="text-text-muted hover:text-danger transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {score && (
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-bg-muted rounded-lg p-2">
                <div className="text-[10px] text-text-muted uppercase tracking-wider">
                  Expected Value
                </div>
                <div className="text-sm font-bold text-text-primary font-mono">
                  €{score.expectedValue.toFixed(0)}
                </div>
              </div>
              <div className="bg-bg-muted rounded-lg p-2">
                <div className="text-[10px] text-text-muted uppercase tracking-wider">
                  Confidence
                </div>
                <div
                  className="text-sm font-bold font-mono"
                  style={{
                    color:
                      score.confidence >= 0.5 ? 'var(--color-success)' : 'var(--color-warning)',
                  }}
                >
                  {(score.confidence * 100).toFixed(0)}%
                </div>
              </div>
              <div className="bg-bg-muted rounded-lg p-2">
                <div className="text-[10px] text-text-muted uppercase tracking-wider">Buy Max</div>
                <div className="text-sm font-bold text-text-primary font-mono">
                  €{score.suggestedBuyMax.toFixed(0)}
                </div>
              </div>
              <div className="bg-bg-muted rounded-lg p-2">
                <div className="text-[10px] text-text-muted uppercase tracking-wider">
                  List Price
                </div>
                <div className="text-sm font-bold text-accent font-mono">
                  €{score.suggestedListPrice.toFixed(0)}
                </div>
              </div>
            </div>
          )}

          {score?.breakdown && (
            <div className="space-y-2 pt-2 border-t border-border">
              <ScoreGauge label="Intrinsic" value={score.breakdown.intrinsic.score} />
              <ScoreGauge label="Commercial" value={score.breakdown.commercial.score} />
              <ScoreGauge label="Market" value={score.breakdown.market.score} />
              <ScoreGauge label="Expiry" value={score.breakdown.expiry.score} />
            </div>
          )}

          <div className="flex gap-2 mt-2">
            {onBuy && candidate.status === 'recommended' && (
              <Button
                variant="success"
                size="sm"
                className="flex-1"
                onClick={() => setShowBuyDialog(true)}
              >
                <ShoppingCart className="h-4 w-4 mr-1" />
                Buy €{score?.suggestedBuyMax.toFixed(0) ?? '?'}
              </Button>
            )}
            {score && <ShareButton domain={candidate.domain} />}
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={showBuyDialog} onOpenChange={setShowBuyDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Purchase {candidate.domain}</AlertDialogTitle>
            <AlertDialogDescription>
              This will open a purchase session for {candidate.domain} at up to €
              {score?.suggestedBuyMax.toFixed(0)}. Continue?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                onBuy?.(candidate.domain);
                setShowBuyDialog(false);
              }}
            >
              Proceed
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
