// SPDX-License-Identifier: AGPL-3.0-only
import type { LegalIdentity } from './legal-identity.js';
import { escapeHtml } from '../api/views/escape.js';

/**
 * The art. 28 GDPR DPA, generated from the operator identity.
 *
 * A static template with `[●]` fields cannot be incorporated into a contract:
 * it is not an agreement with anyone. The processor's identity is the same
 * configuration that produces the legal notice, so the DPA is generated from
 * it at request time. When the identity is incomplete the route returns 404
 * and the terms say the DPA is available on request — never a blank contract.
 */
export interface DpaRenderOptions {
  identity: LegalIdentity;
  sourceCodeUrl: string;
  subProcessors: ReadonlyArray<{
    name: string;
    purpose: string;
    country: string;
    mechanism: string;
  }>;
}

export function dpaIsGeneratable(identity: LegalIdentity): boolean {
  return (
    identity.entityName.trim() !== '' &&
    identity.registeredAddress.trim() !== '' &&
    identity.privacyEmail.trim() !== '' &&
    identity.vatId.trim() !== ''
  );
}

export function renderDpaHtml(options: DpaRenderOptions): string {
  const { identity, subProcessors } = options;
  const e = escapeHtml;
  const rows = subProcessors
    .map(
      (p) =>
        `<tr><td>${e(p.name)}</td><td>${e(p.purpose)}</td><td>${e(p.country)}</td><td>${e(p.mechanism)}</td></tr>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Data processing agreement — DOMINUS Cloud</title>
<meta name="robots" content="noindex"></head>
<body>
<h1>Data processing agreement (GDPR art. 28)</h1>
<p>This agreement is between the customer (controller) and the operator of DOMINUS Cloud (processor). The customer's details are those on the account from which the agreement is accepted; the processor's details are published below.</p>

<h2>Parties</h2>
<ul>
<li><strong>Processor:</strong> ${e(identity.entityName)} (${e(identity.legalForm)}), ${e(identity.registeredAddress)}, VAT ID ${e(identity.vatId)}, REA ${e(identity.reaNumber)}, ${e(identity.registroImprese)}, PEC ${e(identity.pec)}.</li>
<li><strong>Contact for data protection matters:</strong> ${e(identity.privacyEmail)}.</li>
<li><strong>Supervisory authority:</strong> ${e(identity.supervisoryAuthority)}.</li>
</ul>

<h2>1. Subject matter and duration</h2>
<p>The processor provides the DOMINUS Cloud service: domain valuation, portfolio tracking, renewal verdicts and, when enabled, the post-acquisition automation pipeline. The agreement starts when the service is provisioned and ends when the subscription is cancelled and the data has been returned or deleted.</p>

<h2>2. Nature and purpose</h2>
<p>The processor processes personal data only to provide the service on the controller's documented instructions: authentication, team administration, usage metering, billing, service operation, automated-action audit, and security diagnostics.</p>

<h2>3. Categories of data subjects and data</h2>
<p>Data subjects are the controller's users, team members and invited users. Data includes identification and contact data, authentication data, usage and billing data, and the business data the controller enters. The controller is responsible for the lawfulness of the data it enters.</p>

<h2>4. Sub-processors and transfers</h2>
<table border="1"><thead><tr><th>Sub-processor</th><th>Purpose</th><th>Country</th><th>Transfer mechanism</th></tr></thead>
<tbody>${rows}</tbody></table>
<p>Transfers outside the EEA use the European Commission standard contractual clauses and, where applicable and certified, the EU-US Data Privacy Framework. The processor gives notice of changes and an opportunity to object.</p>

<h2>5. Security measures</h2>
<p>TLS in transit; encryption at rest for stored provider credentials; tenant isolation enforced by row-level security; append-only audit trail; encrypted backups with a rotation window of about thirty days; structured logs without payload content; no third-party analytics or advertising.</p>

<h2>6. Return and deletion</h2>
<p>On termination the processor returns or deletes the data, except for records that law requires to be kept (invoices and accounting records, ten years under Italian law). Deletion does not reach copies inside the rolling backup window; those copies are overwritten by rotation and deletion is re-applied after any restore.</p>

<h2>7. Assistance, audit and liability</h2>
<p>The processor assists with data-subject requests, security obligations and impact assessments, makes the information needed to demonstrate compliance available, and allows one audit per year unless a breach or authority requires more. Liability is governed by the Terms of Service, without prejudice to mandatory law.</p>

<h2>8. Governing law</h2>
<p>Italian law. The jurisdiction provisions of the Terms of Service apply.</p>

<p>The text of the service and its source are published at ${e(options.sourceCodeUrl)}.</p>
</body>
</html>`;
}
