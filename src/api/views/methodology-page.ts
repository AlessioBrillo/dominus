// SPDX-License-Identifier: AGPL-3.0-only
import { pageHtml, BASE_CSS_HREF, SITE_NAME } from './page-template.js';
import { breadcrumbJsonLd, metaTags, organizationJsonLd } from './jsonld.js';
import { escapeHtml } from './escape.js';

/**
 * A factual, server-rendered explanation of what an automated estimate is
 * and is not. In a market of unexplained single numbers, the most credible
 * thing a scorer can publish is how it reasons and where it stops.
 */
export function renderMethodologyPage(siteUrl: string, signupUrl?: string): string {
  const base = siteUrl.replace(/\/$/, '');
  const canonical = '/public/methodology';
  const cta = signupUrl ?? `${base}/signup`;

  const headExtras = [
    metaTags({
      title: `How DOMINUS scores a domain | ${SITE_NAME}`,
      description:
        'The four signals behind an automated DOMINUS estimate, its data sources, its limits and why it is not an appraisal.',
      canonical,
      siteUrl: base,
    }),
    breadcrumbJsonLd(
      [
        { position: 1, name: 'Home', path: '/' },
        { position: 2, name: 'Methodology', path: canonical },
      ],
      base,
    ),
    organizationJsonLd(base),
  ].join('\n');

  const bodyContent = [
    '<div class="card wide">',
    '<h1>How DOMINUS scores a domain</h1>',
    '<p class="subtitle">A decision aid, not an appraisal</p>',
    '<p>An automated estimate combines four signals. Each one contributes only when it has evidence: when data is missing, the score says so and the weight is redistributed instead of being invented. The engine is deliberately more conservative than commercial appraisal tools (ADR-0002).</p>',
    '<h2>The four signals</h2>',
    '<table>',
    '<thead><tr><th scope="col">Signal</th><th scope="col">Question it answers</th><th scope="col">Typical source</th></tr></thead>',
    '<tbody>',
    '<tr><th scope="row">Intrinsic</th><td>Is the name short, pronounceable and free of hyphens or numbers?</td><td>The domain string and its TLD</td></tr>',
    '<tr><th scope="row">Commercial</th><td>Is there measurable search demand and paid competition for the term?</td><td>Keyword Planner data you supply, Google Suggest, or both through the composite provider</td></tr>',
    '<tr><th scope="row">Market</th><td>What have similar names actually sold for, and how recent is that evidence?</td><td>Comparable sales you supply or a licensed provider</td></tr>',
    '<tr><th scope="row">Expiry</th><td>For closeouts: does the name carry age, backlinks and history that justify the renewal?</td><td>Your closeout import and the Wayback machine</td></tr>',
    '</tbody>',
    '</table>',
    '<h2>What the score cannot see</h2>',
    '<ul>',
    '<li>Trademark screening checks public registers for conflicting marks; it is not a legal clearance opinion and it is not legal advice. We call it <strong>screening</strong> deliberately.</li>',
    '<li>When a trademark source gives no answer, the candidate is held as pending and is never recommended. "No answer" is not "clear".</li>',
    '<li>Commercial data can be measured or estimated. The score reports which one it used; an estimated signal carries less confidence than a measured one.</li>',
    '<li>Sales data can be sparse or old. The market signal shrinks as its evidence thins rather than guessing a price.</li>',
    '<li>Bundled example files are synthetic fixtures. A score produced from them demonstrates the output format; it is not a valuation.</li>',
    '</ul>',
    `<p>Every public estimate is an automated heuristic estimate. It is not an appraisal, not an offer to buy or sell the domain and not investment advice. See the <a href="/public/data-sources">data sources and attribution page</a> and the <a href="/legal-notice">legal notice</a>.</p>`,
    `<p class="cta-row"><a class="cta" href="${escapeHtml(cta)}">Track your domains and get keep/drop verdicts</a></p>`,
    '<p class="footer">Scored with DOMINUS. The engine is open source under AGPL v3.</p>',
    '</div>',
  ].join('\n');

  return pageHtml(
    `How DOMINUS scores a domain | ${SITE_NAME}`,
    headExtras,
    BASE_CSS_HREF,
    bodyContent,
  );
}
