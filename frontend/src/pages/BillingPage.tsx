import {
  useSubscription,
  useCreateCheckoutSession,
  useCreatePortalSession,
} from '@/hooks/useBilling';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { CreditCard } from 'lucide-react';

const PLAN_LABELS: Record<string, string> = {
  free: 'Community',
  pro: 'Pro',
  enterprise: 'Enterprise',
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
  const checkoutMutation = useCreateCheckoutSession();
  const portalMutation = useCreatePortalSession();

  const subscription = data?.subscription;
  const isStripeConfigured = data?.isStripeConfigured ?? false;

  const handleUpgrade = () => {
    const baseUrl = `${window.location.protocol}//${window.location.host}`;
    checkoutMutation.mutate({
      priceId: '', // Set via env var — user must configure STRIPE_PRICE_ID_MONTHLY
      successUrl: `${baseUrl}/billing`,
      cancelUrl: `${baseUrl}/billing`,
    });
  };

  const handleManageBilling = () => {
    portalMutation.mutate(window.location.href);
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <h2 className="text-2xl font-bold text-text-primary">Billing</h2>

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
                {subscription.plan === 'free' && isStripeConfigured && (
                  <Button onClick={handleUpgrade} disabled={checkoutMutation.isPending}>
                    {checkoutMutation.isPending ? 'Redirecting...' : 'Upgrade to Pro'}
                  </Button>
                )}

                {isStripeConfigured && subscription.stripeCustomerId && (
                  <Button
                    variant="outline"
                    onClick={handleManageBilling}
                    disabled={portalMutation.isPending}
                  >
                    {portalMutation.isPending ? 'Opening...' : 'Manage Billing'}
                  </Button>
                )}
              </div>

              {!isStripeConfigured && subscription.plan === 'free' && (
                <p className="text-sm text-text-muted italic">
                  Billing is not configured on this instance. Set{' '}
                  <code className="text-xs bg-bg-elevated px-1 rounded">STRIPE_SECRET_KEY</code> to
                  enable subscriptions.
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
            <CardTitle>Plans</CardTitle>
            <CardDescription>Choose a plan that fits your needs</CardDescription>
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
              <PlanCard
                name="Pro"
                price="€19/mo"
                features={[
                  'Multi-tenant',
                  'PostgreSQL database',
                  'Priority support',
                  'Stripe billing',
                ]}
                current={subscription?.plan === 'pro'}
                highlighted
              />
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function PlanCard({
  name,
  price,
  features,
  current,
  highlighted,
}: {
  name: string;
  price: string;
  features: string[];
  current?: boolean;
  highlighted?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border p-4 ${
        highlighted ? 'border-brand-500 bg-brand-900/20' : 'border-border bg-bg-elevated'
      }`}
    >
      <h3 className="font-semibold text-text-primary">{name}</h3>
      <p className="text-2xl font-bold text-text-primary mt-1">{price}</p>
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
    </div>
  );
}
