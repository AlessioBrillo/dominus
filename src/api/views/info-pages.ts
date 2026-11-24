// SPDX-License-Identifier: AGPL-3.0-only
import { escapeHtml } from './escape.js';
import { pageHtml, BASE_CSS_HREF } from './page-template.js';

/**
 * The factual pages the legal documents point at.
 *
 * The legal notice promises that the sources, their terms and their
 * attribution are described on the data-sources page. A promise in a legal
 * document without a page behind it is worse than no promise: it looks like
 * a disclosure and is not one. This module supplies that page, and the
 * third-party-notices route supplies the license texts the AGPL and the
 * upstream licenses require to be shipped with the service.
 */

interface SourceRow {
  data: string;
  source: string;
  terms: string;
}

const DATA_SOURCES: SourceRow[] = [
  {
    data: 'Domain availability (RDAP)',
    source: 'rdap.org bootstrap service and the IANA RDAP bootstrap registry',
    terms: 'Public infrastructure. See https://rdap.org and https://data.iana.org/rdap/dns.json',
  },
  {
    data: 'Trademark screening',
    source: 'USPTO public API and EUIPO OAuth2 API',
    terms:
      'Public government data. A match or a clear verdict is a screening result, not a legal clearance.',
  },
  {
    data: 'Archived web history',
    source: 'Internet Archive CDX API',
    terms:
      'Public API. DOMINUS requests snapshots for domains you submit and does not republish the archive.',
  },
  {
    data: 'Comparable sales (optional)',
    source: 'A local file you provide with COMPS_DATA_PATH, for example a NameBio export',
    terms:
      'NameBio data requires attribution: https://namebio.com/terms. DOMINUS does not ship or redistribute NameBio data.',
  },
  {
    data: 'Keyword demand (optional)',
    source:
      'Google Suggest, a local file you provide with KEYWORD_DATA_PATH, or both through KEYWORD_PROVIDER=composite (which reports which leg answered)',
    terms:
      'Google Keyword Planner data is subject to the Google Ads Terms of Service and is not redistributed. DOMINUS ships synthetic sample data only.',
  },
  {
    data: 'Parking IP ranges',
    source: 'src/providers/dns/parking-ips.json (RIR allocations)',
    terms: 'Factual IP ranges; no upstream attribution requirement.',
  },
];

const row = (s: SourceRow): string =>
  `<tr><th scope="row">${escapeHtml(s.data)}</th><td>${escapeHtml(s.source)}</td><td>${escapeHtml(s.terms)}</td></tr>`;

export function dataSourcesPageHtml(sourceCodeUrl?: string): string {
  const source = sourceCodeUrl ?? 'https://github.com/AlessioBrillo/dominus';
  const bodyContent = [
    '<div class="card wide">',
    '<h1>Data sources and attribution</h1>',
    '<p class="subtitle">What DOMINUS reads, and under what terms</p>',
    '<p>DOMINUS computes estimates from the sources below. It does not republish the source data. Each source remains the property of its owner and is governed by its own terms.</p>',
    '<table>',
    '<thead><tr><th scope="col">Data</th><th scope="col">Source</th><th scope="col">Terms</th></tr></thead>',
    '<tbody>',
    ...DATA_SOURCES.map(row),
    '</tbody>',
    '</table>',
    '<p class="footer">The estimates produced from these sources are automated and heuristic. They are not appraisals, offers or investment advice. See the <a href="/legal-notice">legal notice</a> and the <a href="/privacy">Privacy Notice</a>.</p>',
    `<p class="footer">Source code and licence: <a href="${escapeHtml(source)}">DOMINUS on GitHub</a> · <a href="/public/license">AGPL v3 text</a>.</p>`,
    '</div>',
  ].join('\n');

  const headExtras = [
    '<meta name="description" content="The public data sources DOMINUS uses for domain estimates, and their terms and attribution.">',
    '<link rel="canonical" href="/public/data-sources">',
  ].join('\n');

  return pageHtml('Data sources | DOMINUS', headExtras, BASE_CSS_HREF, bodyContent);
}
