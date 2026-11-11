// SPDX-License-Identifier: AGPL-3.0-only
import { Link } from 'react-router-dom';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { LoginForm } from '@/components/LoginForm';
import { ShieldCheck, Gauge, Briefcase, ArrowRight } from 'lucide-react';

/**
 * The public front door.
 *
 * Until now the root path of the application was the sign-in form: a
 * stranger who arrived from a search engine, a forum post or a
 * competitor's comparison page found a password box and nothing else.
 * There was no page that said what the product does, what it costs, or
 * why it is different - so there was nothing to convert and nothing to
 * share.
 *
 * The page answers three questions in order: what it does, what it costs,
 * and how to start. The sign-in stays on the page: a customer who already
 * has a workspace must not have to hunt for the login.
 */
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
    body: 'Buy or pass. The engine answers with an expected value, a confidence and the maximum you should pay - and it is deliberately more conservative than the commercial appraisal tools.',
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

const PLANS = [
  {
    id: 'free',
    name: 'Community',
    price: 'Free',
    unit: 'forever',
    features: [
      'One workspace',
      '50 candidates scored per month',
      '25 domains tracked',
      'All core features',
    ],
    cta: 'Start free',
  },
  {
    id: 'pro',
    name: 'Pro',
    price: '€29',
    unit: 'per month',
    features: [
      '500 candidates scored per month',
      '250 domains tracked',
      '3 people, 5 machine keys',
      'Priority support',
    ],
    cta: 'Start with Pro',
    highlighted: true,
  },
  {
    id: 'team',
    name: 'Team',
    price: '€79',
    unit: 'per month',
    features: [
      '2,500 candidates scored per month',
      '1,000 domains tracked',
      '10 people, 20 machine keys',
      'Shared workspaces',
    ],
    cta: 'Start with Team',
  },
];

export function LandingPage() {
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
            <a href="#pricing" className="text-sm text-text-secondary hover:text-text-primary">
              Pricing
            </a>
            <a href="#how" className="text-sm text-text-secondary hover:text-text-primary">
              How it works
            </a>
            <Link
              to="/signup"
              className="rounded-lg bg-brand-700 px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
            >
              Create a workspace
            </Link>
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
                A domain is worth what the evidence says it is worth.
              </h1>
              <p className="mt-4 max-w-2xl text-lg text-text-secondary">
                DOMINUS runs the five checks a domain investment needs - availability, registry
                confirmation, valuation, trademark clearance - and answers one question per domain:
                buy or pass. It never recommends a domain whose trademark could not be checked.
              </p>
              <div className="mt-8 flex flex-wrap items-center gap-3">
                <Link
                  to="/signup"
                  className="inline-flex items-center gap-2 rounded-lg bg-brand-700 px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90"
                >
                  Create a workspace
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </Link>
                <a
                  href="#how"
                  className="rounded-lg border border-border px-4 py-2.5 text-sm font-medium text-text-secondary hover:text-text-primary"
                >
                  See how it works
                </a>
              </div>
              <p className="mt-4 text-xs text-text-muted">
                Self-host the community edition for free - the same features, your own
                infrastructure.
              </p>
            </div>

            <Card>
              <CardHeader>
                <CardTitle>Sign In</CardTitle>
                <CardDescription>Enter your API key to access the dashboard</CardDescription>
              </CardHeader>
              <CardContent>
                <LoginForm embedded />
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

        <section id="pricing" className="border-t border-border bg-bg-secondary">
          <div className="mx-auto max-w-6xl px-4 py-16">
            <h2 className="text-2xl font-bold text-text-primary">Pricing</h2>
            <p className="mt-2 max-w-2xl text-text-secondary">
              Every plan runs the same engine. The limits are the work you ask the platform to do.
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
                      <span className="text-3xl font-bold text-text-primary">{plan.price}</span>
                      <span className="text-sm text-text-muted">{plan.unit}</span>
                    </p>
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
                    <Link
                      to="/signup"
                      className={`mt-6 block rounded-lg px-3 py-2 text-center text-sm font-medium ${
                        plan.highlighted
                          ? 'bg-brand-700 text-white hover:opacity-90'
                          : 'border border-border text-text-primary hover:bg-bg-hover'
                      }`}
                    >
                      {plan.cta}
                    </Link>
                  </CardContent>
                </Card>
              ))}
            </div>
            <p className="mt-6 text-xs text-text-muted">
              Enterprise (dedicated infrastructure, custom SLA and SSO) is sold on contract. Prices
              exclude VAT.
            </p>
          </div>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-8 text-xs text-text-muted">
          <span>DOMINUS - open-source domain investment decision support.</span>
          <nav aria-label="Legal" className="flex gap-4">
            <Link to="/legal-notice" className="hover:text-text-primary">
              Legal notice
            </Link>
            <Link to="/terms" className="hover:text-text-primary">
              Terms
            </Link>
            <Link to="/privacy" className="hover:text-text-primary">
              Privacy
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
