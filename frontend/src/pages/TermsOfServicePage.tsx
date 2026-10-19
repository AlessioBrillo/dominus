// SPDX-License-Identifier: AGPL-3.0-only
import { Button } from '@/components/ui/button';
import { Link } from 'react-router-dom';

export function TermsOfServicePage() {
  return (
    <div className="max-w-2xl mx-auto p-6 space-y-6">
      <h1 className="text-2xl font-bold text-text-primary">Terms of Service</h1>
      <p className="text-text-muted text-sm">Last updated: October 2026</p>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-text-primary">1. Acceptance of terms</h2>
        <p className="text-text-secondary">
          By accessing or using DOMINUS (the "Service"), you agree to be bound by these Terms of
          Service. If you do not agree, you may not use the Service.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-text-primary">2. Description of service</h2>
        <p className="text-text-secondary">
          DOMINUS is an open-source domain investment decision-support tool. It provides domain
          valuation, portfolio management, and automation features to help you make informed
          purchase, hold, and drop decisions. The Service is available as a self-hosted community
          edition (AGPL v3) and as a managed DOMINUS Cloud service.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-text-primary">3. No investment advice</h2>
        <p className="text-text-secondary">
          DOMINUS provides decision-support data and heuristics, not financial or investment advice.
          Valuation figures, buy ceilings, and drop verdicts are estimates based on the data you
          provide and on free public sources. You are solely responsible for your investment
          decisions and any financial loss resulting from them.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-text-primary">4. Trademark gate</h2>
        <p className="text-text-secondary">
          DOMINUS checks candidate domains against USPTO and EUIPO trademark records. A match blocks
          a buy recommendation. This check is mandatory and cannot be bypassed. DOMINUS does not
          guarantee that a domain is free of trademark risk; you should conduct your own legal due
          diligence before purchasing any domain.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-text-primary">5. Automated actions</h2>
        <p className="text-text-secondary">
          The post-acquisition automation pipeline (DNS delegation, parking, marketplace listing)
          ships disabled by default ({'AUTOMATION_ENABLED=false'}) and dry-run by default. You are
          responsible for reviewing and enabling automation steps. Any spend or DNS mutation
          performed through connected provider accounts is your responsibility.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-text-primary">6. Pricing and billing</h2>
        <p className="text-text-secondary">
          DOMINUS Cloud subscriptions are billed through Stripe. Taxes are calculated and collected
          at the applicable rate for your jurisdiction. You may cancel your subscription at any
          time; cancellation takes effect at the end of the current billing period.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-text-primary">7. Limitation of liability</h2>
        <p className="text-text-secondary">
          To the fullest extent permitted by law, DOMINUS and its contributors are not liable for
          any indirect, incidental, special, consequential, or punitive damages, or any loss of
          profits or revenue, arising out of or related to your use of the Service.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-text-primary">8. License</h2>
        <p className="text-text-secondary">
          The community edition is licensed under AGPL v3. You may use, study, share, and modify the
          source code, and you may offer modified versions as a network service provided you publish
          your modifications under the same license (AGPL §13). Commercial licenses are available
          for organizations that require proprietary embedding without AGPL obligations.
        </p>
      </section>

      <div className="pt-8 flex gap-3">
        <Button asChild>
          <Link to="/privacy">Privacy Policy</Link>
        </Button>
        <Button asChild variant="outline">
          <Link to="/impressum">Impressum</Link>
        </Button>
      </div>
    </div>
  );
}
