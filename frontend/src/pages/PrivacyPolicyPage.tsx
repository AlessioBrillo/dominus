// SPDX-License-Identifier: AGPL-3.0-only
import { Button } from '@/components/ui/button';
import { Link } from 'react-router-dom';

export function PrivacyPolicyPage() {
  return (
    <div className="max-w-2xl mx-auto p-6 space-y-6">
      <h1 className="text-2xl font-bold text-text-primary">Privacy Policy</h1>
      <p className="text-text-muted text-sm">Last updated: October 2026</p>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-text-primary">1. Introduction</h2>
        <p className="text-text-secondary">
          DOMINUS respects your privacy. This Privacy Policy explains what personal data we collect,
          how we use it, and your rights under the General Data Protection Regulation (GDPR) and
          other applicable data protection laws.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-text-primary">2. Data we collect</h2>
        <p className="text-text-secondary">
          DOMINUS is primarily self-hosted. Your data (domains, scores, portfolio entries, revenue
          records, automation audit) is stored in your own database (SQLite or PostgreSQL) and never
          transmitted to DOMINUS authors.
        </p>
        <p className="text-text-secondary">
          When you use DOMINUS Cloud (the managed service), the following may be processed: email
          address, team seat membership, API key metadata, billing contact information, and usage
          metrics (number of pipeline runs, API calls) for plan enforcement.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-text-primary">3. How we use your data</h2>
        <p className="text-text-secondary">
          Personal data is used to operate the Service, authenticate users, enforce plan limits,
          send team invitations (optional), and process billing. We do not sell your data to third
          parties.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-text-primary">4. Third-party providers</h2>
        <p className="text-text-secondary">
          DOMINUS queries free public data sources (public RDAP, USPTO, EUIPO) and, when configured,
          your own provider accounts (registrar, parking, AdSense, GSC, marketplace). Credentials
          you store in the tenant credential vault are encrypted at rest and are used only to make
          API calls on your behalf.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-text-primary">5. Data retention</h2>
        <p className="text-text-secondary">
          You control retention. The automation audit trail is pruned after 90 days (configurable
          via AUTOMATION_AUDIT_RETENTION_DAYS). Pipeline run history, candidate data, and scoring
          runs are subject to the prune maintenance command. You may delete your portfolio,
          outcomes, and automation data at any time through the CLI or API.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-text-primary">6. Your rights</h2>
        <p className="text-text-secondary">
          You may request access to, rectification of, erasure of, or export of your personal data.
          For DOMINUS Cloud, contact the privacy contact listed in the Impressum. For self-hosted
          deployments, you control your database and can export or delete your data directly.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-text-primary">7. Cookies</h2>
        <p className="text-text-secondary">
          The DOMINUS frontend uses session cookies for authentication (SSO mode) and may use
          essential cookies for CSRF protection and language/theme preference. No tracking or
          advertising cookies are used.
        </p>
      </section>

      <div className="pt-8 flex gap-3">
        <Button asChild>
          <Link to="/terms">Terms of Service</Link>
        </Button>
        <Button asChild variant="outline">
          <Link to="/impressum">Impressum</Link>
        </Button>
      </div>
    </div>
  );
}
