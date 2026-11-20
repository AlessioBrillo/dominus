// SPDX-License-Identifier: AGPL-3.0-only
import {
  useSubscription,
  useCreateCheckoutSession,
  useCreatePortalSession,
  useChangeSubscription,
  useCancelSubscription,
} from '@/hooks/useBilling';
import { useState } from 'react';
import { useLegalContent } from '@/hooks/useLegalContent';
import type { BillingInterval, BillingPlan } from '@/api/billing';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { CreditCard } from 'lucide-react';

const PLAN_LABELS: Record<string, string> = {
  free: 'Community',
  pro: 'Pro',
  team: 'Team',
  enterprise: 'Enterprise',
};

const PLAN_NET_EUR: Record<BillingPlan, { month: number; year: number }> = {
  pro: { month: 29, year: 290 },
  team: { month: 79, year: 790 },
  enterprise: { month: 0, year: 0 },
};

type VatRegime = 'ordinary' | 'forfettario' | 'none';

function planUnit(interval: BillingInterval): string {
  return interval === 'month' ? 'mo' : 'yr';
}

/** The displayed price follows the operator's configured VAT regime. */
function planPrice(plan: BillingPlan, interval: BillingInterval, regime: VatRegime): string {
  if (plan === 'enterprise') return 'Custom';
  const net = PLAN_NET_EUR[plan][interval];
  return `€${regime === 'ordinary' ? (net * 1.22).toFixed(2) : net}/${planUnit(interval)}`;
}

function planNote(
  plan: BillingPlan,
  interval: BillingInterval,
  regime: VatRegime,
): string | undefined {
  if (plan === 'enterprise') return undefined;
  if (regime === 'ordinary') {
    return `€${PLAN_NET_EUR[plan][interval]}/${planUnit(interval)} + VAT for business`;
  }
  return regime === 'forfettario' ? 'VAT not applicable (flat-rate regime)' : 'VAT not charged';
}

function vatExplainer(regime: VatRegime): string {
  if (regime === 'ordinary') {
    return 'Prices include VAT; the rate for your country of residence is applied before payment. Business customers need a valid VAT identification number for the reverse charge.';
  }
  if (regime === 'forfettario') {
    return 'The operator applies the Italian flat-rate regime: prices are outside the scope of VAT.';
  }
  return 'The operator is not subject to VAT: prices are shown as the total payable.';
}

const PLAN_FEATURES: Record<BillingPlan, string[]> = {
  pro: [
    '500 candidates/month',
    '250 domains tracked',
    '3 people, 5 machine keys',
    'Priority support',
  ],
  team: [
    '2,500 candidates/month',
    '1,000 domains tracked',
    '10 people, 20 machine keys',
    'Shared workspaces',
  ],
  enterprise: ['Everything in Team', 'Custom limits', 'Dedicated support', 'Custom SLA'],
};

const STATUS_VARIANTS: Record<string, 'success' | 'warning' | 'danger' | 'default'> = {
  active: 'success',
  trialing: 'success',
  past_due: 'warning',
  canceled: 'danger',
  incomplete: 'warning',
};

export function BillingPage() {
  const { data, isLoading } = useSubscription();
  const { data: legal } = useLegalContent();
  const vatRegime: VatRegime = legal?.identity.vatRegime ?? 'ordinary';
  const checkoutMutation = useCreateCheckoutSession();
  const portalMutation = useCreatePortalSession();
  const changeMutation = useChangeSubscription();
  const cancelMutation = useCancelSubscription();
  const [interval, setInterval] = useState<BillingInterval>('month');

  const subscription = data?.subscription;
  const checkoutEnabled = data?.checkoutEnabled ?? data?.isStripeConfigured ?? false;
  const isStripeConfigured = checkoutEnabled && (data?.isStripeConfigured ?? false);
  const plans = data?.plans ?? [];

  // A tenant that already subscribes changes its plan on the existing
  // subscription (ADR-0103). A tenant that does not subscribes starts a
  // checkout.
  const hasSubscription = Boolean(subscription?.stripeSubscriptionId);

  const handleUpgrade = (plan: BillingPlan) => {
    if (hasSubscription) {
      changeMutation.mutate({ plan, interval });
      return;
    }
    const baseUrl = `${window.location.protocol}//${window.location.host}`;
    checkoutMutation.mutate({
      plan,
      interval,
      successUrl: `${baseUrl}/billing`,
      cancelUrl: `${baseUrl}/billing`,
    });
  };

  const handleManageBilling = () => {
    portalMutation.mutate(window.location.href);
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <h2 className="text-2xl font-bold text-text-primary">Billing</h2>

      {!isLoading && !checkoutEnabled && (
        <Card>
          <CardHeader>
            <CardTitle>Billing is not active</CardTitle>
            <CardDescription>
              DOMINUS Cloud is not open for paid subscriptions on this deployment.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-text-secondary">
              No price is offered and no checkout is available. See the landing page for the
              waitlist and the community edition.
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Current Plan</CardTitle>
              <CardDescription>
                {subscription
                  ? `You are on the ${PLAN_LABELS[subscription.plan] ?? subscription.plan} plan`
                  : 'Loading...'}
              </CardDescription>
            </div>
            <CreditCard className="h-5 w-5 text-text-muted" />
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : subscription ? (
            <>
              <div className="flex items-center gap-3">
                <span className="text-lg font-semibold text-text-primary">
                  {PLAN_LABELS[subscription.plan] ?? subscription.plan}
                </span>
                <Badge variant={STATUS_VARIANTS[subscription.status] ?? 'default'}>
                  {subscription.status}
                </Badge>
              </div>

              {subscription.currentPeriodEnd && (
                <p className="text-sm text-text-muted">
                  Current period ends:{' '}
                  {new Date(subscription.currentPeriodEnd).toLocaleDateString()}
                </p>
              )}

              <div className="flex gap-3 pt-2">
                {subscription.stripeCustomerId && (
                  <Button
                    variant="outline"
                    onClick={handleManageBilling}
                    disabled={portalMutation.isPending}
                  >
                    {portalMutation.isPending ? 'Opening...' : 'Manage Billing'}
                  </Button>
                )}
                {subscription.stripeSubscriptionId && (
                  <Button
                    variant="outline"
                    onClick={() => cancelMutation.mutate('period_end')}
                    disabled={cancelMutation.isPending}
                  >
                    {cancelMutation.isPending ? 'Cancelling...' : 'Cancel subscription'}
                  </Button>
                )}
              </div>

              {!checkoutEnabled && subscription.plan === 'free' && (
                <p className="text-sm text-text-muted italic">
                  Billing and checkout are disabled on this deployment. The community edition does
                  not need a subscription.
                </p>
              )}
            </>
          ) : (
            <p className="text-sm text-text-muted">Unable to load subscription data.</p>
          )}
        </CardContent>
      </Card>

      {isStripeConfigured && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Plans</CardTitle>
                <CardDescription>Choose a plan that fits your needs</CardDescription>
              </div>
              <div className="flex rounded-lg border border-border overflow-hidden">
                {(['month', 'year'] as BillingInterval[]).map((iv) => (
                  <button
                    key={iv}
                    onClick={() => setInterval(iv)}
                    className={`px-3 py-1.5 text-sm font-medium capitalize ${
                      interval === iv
                        ? 'bg-brand-500 text-white'
                        : 'bg-bg-elevated text-text-muted hover:text-text-primary'
                    }`}
                  >
                    {iv === 'year' ? 'Yearly' : 'Monthly'}
                  </button>
                ))}
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 sm:grid-cols-2">
              <PlanCard
                name="Community"
                price="Free"
                features={[
                  'Single user',
                  'SQLite database',
                  'All core features',
                  'Community support',
                ]}
                current={subscription?.plan === 'free'}
              />
              {plans
                .filter((p) => p.available)
                .map((plan) => (
                  <PlanCard
                    key={plan.id}
                    name={PLAN_LABELS[plan.id] ?? plan.id}
                    price={planPrice(plan.id as BillingPlan, interval, vatRegime)}
                    netPrice={planNote(plan.id as BillingPlan, interval, vatRegime)}
                    features={PLAN_FEATURES[plan.id]}
                    current={subscription?.plan === plan.id}
                    highlighted={plan.id === 'pro'}
                    onUpgrade={
                      subscription?.plan === plan.id
                        ? undefined
                        : () => handleUpgrade(plan.id as BillingPlan)
                    }
                    upgrading={checkoutMutation.isPending || changeMutation.isPending}
                    actionLabel={
                      hasSubscription && subscription?.plan !== plan.id ? 'Switch plan' : 'Upgrade'
                    }
                  />
                ))}
            </div>
            <p className="mt-4 text-xs text-text-muted">
              {vatExplainer(vatRegime)} The total payable is shown before payment.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function PlanCard({
  name,
  price,
  netPrice,
  features,
  current,
  highlighted,
  onUpgrade,
  upgrading,
  actionLabel,
}: {
  name: string;
  price: string;
  netPrice?: string;
  features: string[];
  current?: boolean;
  highlighted?: boolean;
  onUpgrade?: () => void;
  upgrading?: boolean;
  actionLabel?: string;
}) {
  return (
    <div
      className={`rounded-lg border p-4 ${
        highlighted ? 'border-brand-500 bg-brand-900/20' : 'border-border bg-bg-elevated'
      }`}
    >
      <h3 className="font-semibold text-text-primary">{name}</h3>
      <p className="text-2xl font-bold text-text-primary mt-1">{price}</p>
      {netPrice && <p className="text-xs text-text-muted">{netPrice}</p>}
      <ul className="mt-3 space-y-1.5">
        {features.map((f) => (
          <li key={f} className="text-sm text-text-muted flex items-center gap-2">
            <span className="text-green-500">&#10003;</span>
            {f}
          </li>
        ))}
      </ul>
      {current && (
        <Badge variant="success" className="mt-3">
          Current Plan
        </Badge>
      )}
      {onUpgrade && (
        <Button
          onClick={onUpgrade}
          disabled={upgrading}
          variant={highlighted ? 'default' : 'outline'}
          className="mt-4 w-full"
        >
          {upgrading ? 'Working...' : (actionLabel ?? 'Upgrade')}
        </Button>
      )}
    </div>
  );
}
