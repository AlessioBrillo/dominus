// SPDX-License-Identifier: AGPL-3.0-only
import { Link } from 'react-router-dom';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Voluntary accessibility statement.
 *
 * Whether a given operator qualifies for the microenterprise exemption of the
 * European Accessibility Act (Directive (EU) 2019/882, article 4(5)) depends
 * on that operator's own size, so this page does not assert it. The target is
 * WCAG 2.1 AA, which the shipped end-to-end smoke gate checks on public pages.
 */
export function AccessibilityPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-12">
      <h1 className="text-3xl font-bold text-text-primary">Accessibility statement</h1>
      <p className="mt-2 text-sm text-text-muted">Published 23 November 2026.</p>

      <Card className="mt-8">
        <CardHeader>
          <CardTitle>Commitment</CardTitle>
          <CardDescription>
            DOMINUS is designed to be usable by keyboard and by assistive technology. The target is
            Web Content Accessibility Guidelines (WCAG) 2.1 level AA.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-text-secondary">
          <p>
            A microenterprise providing services may qualify for the exemption in article 4(5) of
            the European Accessibility Act (Directive (EU) 2019/882); whether it applies depends on
            the operator of this deployment, identified in the legal notice. This statement is
            published voluntarily.
          </p>
          <p>
            The automated acceptance gate checks keyboard operability, labels, focus order and the
            WCAG 2.1 AA subset on the public pages. Known limitations are tracked as issues in the
            public repository.
          </p>
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Feedback</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-text-secondary">
          <p>
            If a page is difficult to use, report the URL, your browser and assistive technology,
            and what you expected to happen. Use the private security report link in the footer for
            safety issues, or the public issue tracker for accessibility feedback.
          </p>
          <p className="mt-3">
            The binding terms are in the{' '}
            <Link to="/terms" className="underline">
              Terms of Service
            </Link>
            . This statement does not modify them.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
