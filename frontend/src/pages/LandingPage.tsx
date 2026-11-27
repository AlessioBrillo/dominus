// SPDX-License-Identifier: AGPL-3.0-only
import { Link } from 'react-router-dom';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { LoginForm } from '@/components/LoginForm';
import { WaitlistForm } from '@/components/WaitlistForm';
import { useLegalContent } from '@/hooks/useLegalContent';
import { ShieldCheck, Gauge, Briefcase, ArrowRight, ExternalLink, Clock } from 'lucide-react';
import { IS_STORE_BUILD } from '@/api/client';

/**
 * The public front door.
 *
 * The page answers three questions in order: what it does, whether the
 * hosted edition can be bought today, and how to start. The hosted edition
 * is not always on sale: when it is a waitlist, the page says so and does not
 * publish a price, a checkout or a signup that would create a workspace the
 * operator cannot serve.
 *
 * The sign-in stays on the page: a customer who already has a workspace must
 * not have to hunt for it.
 */
const REPOSITORY_URL = 'https://github.com/AlessioBrillo/dominus';

const PIPELINE_STAGES = [
  {
    label: 'Candidate generation',
    detail: 'Keyword combinations, brandable names, closeout imports.',
  },
  {
    label: 'DNS pre-filter',
    detail: 'DNSSEC-validated resolution; never available on an unverified answer.',
  },
  { label: 'RDAP confirmation', detail: 'The registry is asked, and premium names are rejected.' },
  {
    label: 'Scoring',
    detail: 'Expected value, confidence, suggested buy maximum, suggested list price.',
  },
  {
    label: 'Trademark gate',
    detail: 'USPTO and EUIPO. A source that cannot answer blocks the recommendation.',
  },
];

const FEATURES = [
  {
    icon: Gauge,
    title: 'One question per domain',
    body: 'Buy or pass. The engine answers with an expected value, a confidence and the maximum you should pay. It is designed to be conservative: when the data is missing it lowers the estimate or refuses to answer.',
  },
  {
    icon: ShieldCheck,
    title: 'A trademark gate that fails closed',
    body: 'The check runs before any recommendation. If the source cannot answer, the verdict is unverified and the domain is never recommended.',
  },
  {
    icon: Briefcase,
    title: 'The portfolio, not the spreadsheet',
    body: 'A renewal clock per domain, a monthly keep/drop/reprice verdict, and the carry cost of every name you keep.',
  },
];

/**
 * Published list prices, in euro, as the TOTAL payable at checkout.
 * One hosted plan is self-service at launch; dedicated infrastructure is
 * arranged by agreement. Keep in sync with ADR-0111 and the Stripe prices.
 */
const PLANS = [
  {
    id: 'free',
    name: 'Community',
    net: 0,
    unit: 'forever',
    features: [
      'Self-hosted, AGPL v3',
      'One workspace',
      'No usage limits imposed by the project',
      'The full scoring engine and pipeline',
    ],
    cta: 'Self-host for free',
    href: REPOSITORY_URL,
  },
  {
    id: 'hosted-free',
    name: 'Hosted free',
    net: 0,
    unit: 'to evaluate',
    features: [
      '25 appraisals per month',
      '5 domains tracked, with the renewal clock',
      '1 seat and 1 machine key',
      'Upgrade when your real list outgrows it',
    ],
    cta: 'Start free',
    href: '/signup',
  },
  {
    id: 'pro',
    name: 'Pro',
    net: 29,
    unit: 'per month',
    features: [
      '500 candidates scored per month',
      '500 domains tracked',
      '3 people, 5 machine keys',
      '14-day trial with a card, then €29/month',
      'Email support answered within one business day',
    ],
    cta: 'Start Pro trial',
    href: '/signup?plan=pro',
    highlighted: true,
  },
];

type VatRegime = 'ordinary' | 'forfettario' | 'none';

/** The published figure is what the customer pays, whatever the VAT regime. */
function displayPrice(totalEur: number): string {
  return `€${totalEur}`;
}

function priceNote(): string {
  return 'Total payable — VAT included where applicable';
}

function vatExplainer(regime: VatRegime): string {
  if (regime === 'ordinary') {
    return 'The price shown is the total payable: for Italian consumers it already includes 22% VAT. A business customer with a validated VAT ID is invoiced under the reverse charge mechanism and pays the same amount.';
  }
  if (regime === 'forfettario') {
    return 'The operator applies the Italian flat-rate regime: the price shown is the total payable and no VAT is added at checkout.';
  }
  return 'The operator is not subject to VAT: the price shown is the total payable.';
}

export function LandingPage() {
  const { data: legal } = useLegalContent();
  const status = legal?.status;
  // A store build never shows a price or a purchase path (ADR-0114).
  const isPaid = status === 'cloud_paid' && !IS_STORE_BUILD;
  const isWaitlist = status === 'cloud_waitlist';
  const waitlistHref = legal?.waitlistUrl ?? REPOSITORY_URL;
  const waitlistLabel = legal?.waitlistUrl ? 'Join the waitlist' : 'Follow the project';
  const firstPartyWaitlist = isWaitlist && !legal?.waitlistUrl && legal?.waitlistAvailable === true;
  const vatRegime: VatRegime = legal?.identity.vatRegime ?? 'ordinary';

  return (
    <div className="min-h-screen bg-bg-primary text-text-primary">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
          <div className="flex items-center gap-2">
            <span className="text-xl font-bold text-brand-400">DOMINUS</span>
            <span className="hidden text-xs text-text-muted sm:inline">
              Domain investment engine
            </span>
          </div>
          <nav aria-label="Main" className="flex items-center gap-4">
            <a href="#how" className="text-sm text-text-secondary hover:text-text-primary">
              How it works
            </a>
            {isPaid && (
              <a href="#pricing" className="text-sm text-text-secondary hover:text-text-primary">
                Pricing
              </a>
            )}
            <a
              href={REPOSITORY_URL}
              rel="noreferrer"
              className="hidden items-center gap-1 text-sm text-text-secondary hover:text-text-primary sm:inline-flex"
            >
              <ExternalLink className="h-4 w-4" aria-hidden="true" />
              GitHub
            </a>
            <a
              href="#signin"
              className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-text-secondary hover:text-text-primary"
            >
              Sign in
            </a>
          </nav>
        </div>
      </header>

      <main>
        <section className="mx-auto max-w-6xl px-4 py-16">
          <div className="grid gap-10 lg:grid-cols-[3fr_2fr] lg:items-center">
            <div>
              <Badge variant="outline" className="mb-4">
                Buy or pass, with evidence
              </Badge>
              <h1 className="text-4xl font-bold leading-tight text-text-primary sm:text-5xl">
                Buy or pass with evidence, not a guessed price.
              </h1>
              <p className="mt-4 max-w-2xl text-lg text-text-secondary">
                DOMINUS runs five checks - availability, registry confirmation, scoring, trademark
                screening and a renewal clock - and gives you a maximum to pay, a trademark verdict
                and a keep/drop decision. It shows which evidence is missing instead of filling the
                gap with a number. It never recommends a domain whose trademark could not be
                checked.
              </p>
              <p className="mt-3 max-w-2xl text-sm text-text-muted">
                The output is an estimate, not an appraisal and not investment advice. Verify before
                you spend.
              </p>
              <div className="mt-8 flex flex-wrap items-center gap-3">
                {!status ? (
                  <span role="status" className="text-sm text-text-muted">
                    Checking service status…
                  </span>
                ) : isWaitlist && firstPartyWaitlist ? (
                  <WaitlistForm />
                ) : IS_STORE_BUILD ? (
                  <a
                    href={REPOSITORY_URL}
                    rel="noreferrer"
                    className="inline-flex items-center gap-2 rounded-lg bg-brand-700 px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90"
                  >
                    Self-host the community edition
                    <ArrowRight className="h-4 w-4" aria-hidden="true" />
                  </a>
                ) : isWaitlist ? (
                  <a
                    href={waitlistHref}
                    rel="noreferrer"
                    className="inline-flex items-center gap-2 rounded-lg bg-brand-700 px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90"
                  >
                    {waitlistLabel}
                    <ArrowRight className="h-4 w-4" aria-hidden="true" />
                  </a>
                ) : (
                  <Link
                    to="/signup"
                    className="inline-flex items-center gap-2 rounded-lg bg-brand-700 px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90"
                  >
                    Create a workspace
                    <ArrowRight className="h-4 w-4" aria-hidden="true" />
                  </Link>
                )}
                <a
                  href={isWaitlist ? REPOSITORY_URL : '#how'}
                  rel={isWaitlist ? 'noreferrer' : undefined}
                  className="rounded-lg border border-border px-4 py-2.5 text-sm font-medium text-text-secondary hover:text-text-primary"
                >
                  {isWaitlist ? 'Self-host the community edition' : 'See how it works'}
                </a>
              </div>
              {isWaitlist && (
                <p className="mt-4 flex items-start gap-2 text-xs text-text-muted">
                  <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>
                    The hosted edition is not on sale yet. No payment is collected and no workspace
                    is created from this page. The community edition is available now.
                  </span>
                </p>
              )}
            </div>

            <Card id="signin">
              <CardHeader>
                <CardTitle>Sign In</CardTitle>
                <CardDescription>
                  Already have a workspace? Sign in with the API key you saved when it was created.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <LoginForm embedded signupHref={IS_STORE_BUILD || isWaitlist ? null : '/signup'} />
              </CardContent>
            </Card>
          </div>
        </section>

        <section id="how" className="border-t border-border bg-bg-secondary">
          <div className="mx-auto max-w-6xl px-4 py-16">
            <h2 className="text-2xl font-bold text-text-primary">Five checks, in order</h2>
            <p className="mt-2 max-w-2xl text-text-secondary">
              Each stage filters out the candidates the next one does not have to pay for, and a
              domain that fails one of them never reaches a recommendation.
            </p>
            <ol className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              {PIPELINE_STAGES.map((stage, index) => (
                <li
                  key={stage.label}
                  className="rounded-lg border border-border bg-bg-elevated p-4"
                >
                  <span className="text-xs font-semibold text-brand-400">Step {index + 1}</span>
                  <h3 className="mt-1 text-sm font-semibold text-text-primary">{stage.label}</h3>
                  <p className="mt-2 text-xs text-text-muted">{stage.detail}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 py-16">
          <h2 className="text-2xl font-bold text-text-primary">What the decision is made of</h2>
          <div className="mt-8 grid gap-6 md:grid-cols-3">
            {FEATURES.map((feature) => (
              <Card key={feature.title}>
                <CardContent className="pt-6">
                  <feature.icon className="h-6 w-6 text-brand-400" aria-hidden="true" />
                  <h3 className="mt-3 text-base font-semibold text-text-primary">
                    {feature.title}
                  </h3>
                  <p className="mt-2 text-sm text-text-muted">{feature.body}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        {isWaitlist ? (
          <section className="border-t border-border bg-bg-secondary">
            <div className="mx-auto max-w-3xl px-4 py-16">
              <h2 className="text-2xl font-bold text-text-primary">
                The hosted edition is not on sale yet
              </h2>
              <p className="mt-3 text-text-secondary">
                DOMINUS Cloud needs a registered business identity, a confirmed VAT regime and a
                checkout that meets the consumer rules before it can take money. Until then the
                hosted edition is a waitlist, and the community edition is the product you can use
                today: the same engine, your own infrastructure, AGPL v3.
              </p>
              {firstPartyWaitlist ? (
                <WaitlistForm />
              ) : (
                <div className="mt-6 flex flex-wrap gap-3">
                  <a
                    href={waitlistHref}
                    rel="noreferrer"
                    className="inline-flex items-center gap-2 rounded-lg bg-brand-700 px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90"
                  >
                    {waitlistLabel}
                    <ArrowRight className="h-4 w-4" aria-hidden="true" />
                  </a>
                  <a
                    href={REPOSITORY_URL}
                    rel="noreferrer"
                    className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2.5 text-sm font-medium text-text-secondary hover:text-text-primary"
                  >
                    <ExternalLink className="h-4 w-4" aria-hidden="true" />
                    Install the community edition
                  </a>
                </div>
              )}
              {!legal?.waitlistUrl && !firstPartyWaitlist && (
                <p className="mt-4 text-xs text-text-muted">
                  No waitlist form is active on this deployment. The repository is the announcement
                  channel; no email address is collected here.
                </p>
              )}
            </div>
          </section>
        ) : (
          isPaid && (
            <section id="pricing" className="border-t border-border bg-bg-secondary">
              <div className="mx-auto max-w-6xl px-4 py-16">
                <h2 className="text-2xl font-bold text-text-primary">Pricing</h2>
                <p className="mt-2 max-w-2xl text-text-secondary">
                  Every plan runs the same engine. The limits are the work you ask the platform to
                  do. {vatExplainer(vatRegime)}
                </p>
                <div className="mt-8 grid gap-6 md:grid-cols-3">
                  {PLANS.map((plan) => (
                    <Card
                      key={plan.id}
                      className={
                        plan.highlighted ? 'border-brand-500 bg-bg-elevated' : 'bg-bg-elevated'
                      }
                    >
                      <CardContent className="pt-6">
                        <h3 className="text-base font-semibold text-text-primary">{plan.name}</h3>
                        <p className="mt-2 flex items-baseline gap-1">
                          <span className="text-3xl font-bold text-text-primary">
                            {plan.net === 0 ? 'Free' : displayPrice(plan.net)}
                          </span>
                          <span className="text-sm text-text-muted">{plan.unit}</span>
                        </p>
                        {plan.net > 0 && (
                          <p className="mt-1 text-xs text-text-muted">{priceNote()}</p>
                        )}
                        <ul className="mt-4 space-y-2">
                          {plan.features.map((item) => (
                            <li
                              key={item}
                              className="flex items-start gap-2 text-sm text-text-secondary"
                            >
                              <span className="text-green-500" aria-hidden="true">
                                &#10003;
                              </span>
                              {item}
                            </li>
                          ))}
                        </ul>
                        {plan.href.startsWith('http') ? (
                          <a
                            href={plan.href}
                            rel="noreferrer"
                            className="mt-6 block rounded-lg border border-border px-3 py-2 text-center text-sm font-medium text-text-primary hover:bg-bg-hover"
                          >
                            {plan.cta}
                          </a>
                        ) : (
                          <Link
                            to={plan.href}
                            className={`mt-6 block rounded-lg px-3 py-2 text-center text-sm font-medium ${
                              plan.highlighted
                                ? 'bg-brand-700 text-white hover:opacity-90'
                                : 'border border-border text-text-primary hover:bg-bg-hover'
                            }`}
                          >
                            {plan.cta}
                          </Link>
                        )}
                      </CardContent>
                    </Card>
                  ))}
                </div>
                <p className="mt-6 text-xs text-text-muted">
                  Annual billing is €290 (ten monthly payments). Dedicated infrastructure with a
                  custom SLA and SSO is arranged by agreement —{' '}
                  <a
                    className="underline"
                    href="mailto:hello@dominus.app?subject=Dedicated%20infrastructure%20enquiry"
                  >
                    contact us
                  </a>
                  . The consumer may withdraw within 14 days and pays only for the service supplied.
                </p>
              </div>
            </section>
          )
        )}
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-8 text-xs text-text-muted">
          <span>
            DOMINUS - open-source domain investment decision support. Estimates, not appraisals.
          </span>
          <nav aria-label="Legal" className="flex flex-wrap gap-4">
            <Link to="/legal-notice" className="hover:text-text-primary">
              Legal notice
            </Link>
            <Link to="/terms" className="hover:text-text-primary">
              Terms
            </Link>
            <Link to="/privacy" className="hover:text-text-primary">
              Privacy
            </Link>
            <Link to="/accessibility" className="hover:text-text-primary">
              Accessibility
            </Link>
            <a
              href="/.well-known/security.txt"
              className="hover:text-text-primary"
              hidden={!legal?.securityContactAvailable}
            >
              Security
            </a>
            <a href={REPOSITORY_URL} rel="noreferrer" className="hover:text-text-primary">
              GitHub
            </a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
