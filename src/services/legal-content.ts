// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The legal surface, as data.
 *
 * The identity of the service operator (name, address, VAT number, PEC) is
 * operator data, not source code: it changes when the operator changes, and
 * it must be identical on the SPA pages and on the server-rendered public
 * pages. It therefore lives in the configuration (LEGAL_* environment
 * variables) and this module assembles it with the document bodies.
 *
 * Two rules shaped this module:
 *
 * 1. **The text is data, not markup.** The documents are structured
 *    (title, scope, sections with paragraphs and bullets) so that the i18n
 *    work planned for v1.4.0 can translate them without touching a
 *    component, and so that the guardrail script
 *    (scripts/check-legal-placeholders.mjs) can read them.
 *
 * 2. **The community edition is not the Cloud.** A self-hosted deployment is
 *    operated by whoever deployed it: that person is the data controller, the
 *    AGPL governs the software, and none of the Cloud commercial terms apply
 *    to them. The documents say so explicitly instead of showing an
 *    operator identity that does not exist.
 *
 * The Italian law references (art. 7 D.Lgs. 70/2003 for the electronic
 * commerce disclosure, art. 52 and 59 of the Consumer Code for withdrawal,
 * art. 28 GDPR for the data processing agreement) describe the operator's
 * situation: the service is provided by an EU economic operator subject to
 * Italian law. The texts are drafted without formal legal review — ADR-0090
 * records that decision and its consequences.
 */
import type { LegalIdentity } from './legal-identity.js';

/** Date of the last substantive edit of the documents below. */
export const LEGAL_DOCUMENTS_UPDATED_AT = '2026-10-19';

export type LegalDocumentSlug = 'legal-notice' | 'terms' | 'privacy';

export interface LegalSection {
  heading: string;
  paragraphs?: string[];
  bullets?: string[];
}

export interface LegalDocument {
  slug: LegalDocumentSlug;
  title: string;
  /** One-paragraph statement of who the document applies to. */
  scope: string;
  sections: LegalSection[];
}

export interface LegalContent {
  /** 'cloud' when DOMINUS Cloud is operated by the operator; 'community' for a self-hosted deployment. */
  mode: 'cloud' | 'community';
  identity: LegalIdentity;
  documents: LegalDocument[];
}

export interface LegalContentOptions {
  identity: LegalIdentity;
  cloudMode: boolean;
  /** Overrides LEGAL_DOCUMENTS_UPDATED_AT; used by the launch gate. */
  updatedAt?: string;
}

const SELF_HOSTED_IDENTITY: LegalIdentity = {
  entityName: 'The operator of this deployment',
  entityKind: 'individual',
  registeredAddress: 'Not applicable — this is a self-hosted deployment',
  vatId: '',
  reaNumber: '',
  pec: '',
  contactEmail: '',
  privacyEmail: '',
  supervisoryAuthority: '',
};

/** The identity lines rendered in the legal notice, skipping empty fields. */
function identityLines(identity: LegalIdentity): string[] {
  const lines: string[] = [`${identity.entityName}`];
  if (identity.registeredAddress) lines.push(identity.registeredAddress);
  if (identity.vatId) lines.push(`VAT ID: ${identity.vatId}`);
  if (identity.reaNumber) lines.push(`Business register (REA): ${identity.reaNumber}`);
  if (identity.pec) lines.push(`Certified email (PEC): ${identity.pec}`);
  if (identity.contactEmail) lines.push(`Contact: ${identity.contactEmail}`);
  if (identity.privacyEmail) lines.push(`Data protection contact: ${identity.privacyEmail}`);
  return lines;
}

function legalNotice(identity: LegalIdentity, cloudMode: boolean): LegalDocument {
  const sections: LegalSection[] = [];

  if (cloudMode) {
    sections.push({
      heading: '1. Service provider',
      paragraphs: [
        'This website and the DOMINUS Cloud service are provided by the operator identified below, who is the legal person responsible for the service and for the personal data processed through it.',
        ...identityLines(identity).map((line) => line),
      ],
    });
    sections.push({
      heading: '2. Nature of the service',
      paragraphs: [
        'DOMINUS is a decision-support tool for domain investors. It produces valuations, buy ceilings, list prices and renewal verdicts from public data and from the data you provide. It is not an investment service, it does not manage money, and it does not buy or sell domains on your behalf unless you explicitly configure the automation pipeline with your own provider accounts.',
        'The estimates are heuristic. They are deliberately conservative and they can be wrong; the trademark gate reduces but does not eliminate legal risk. Verify before you act.',
      ],
    });
    sections.push({
      heading: '3. Prices, taxes and billing',
      paragraphs: [
        'Prices are shown excluding VAT. VAT is calculated at the rate that applies to your jurisdiction at checkout and is collected by the payment provider. Business customers inside the European Union with a valid VAT identification number are invoiced under the reverse charge mechanism, without Italian VAT.',
        'Subscriptions renew automatically until cancelled. You can cancel at any time from the billing page; the cancellation takes effect at the end of the paid period already paid for.',
      ],
    });
    sections.push({
      heading: '4. Availability',
      paragraphs: [
        'DOMINUS Cloud is provided with the effort and care of a professional service. A service level agreement is provided only to Enterprise customers by contract; for every other plan the service is provided without an uptime commitment.',
      ],
    });
    sections.push({
      heading: '5. Intellectual property and third-party data',
      paragraphs: [
        'The DOMINUS source code is licensed under the GNU Affero General Public License v3; the license text and the source are published with the software. Commercial licenses are available for organisations that need proprietary embedding.',
        'Valuations use public sources such as RDAP registries, the USPTO and EUIPO trademark databases, and archived web data. Those sources remain the property of their owners, and you are responsible for how you use the data you obtain from them.',
      ],
    });
    sections.push({
      heading: '6. Contact',
      paragraphs: [
        `You can reach the operator at ${identity.contactEmail || 'the contact address shown above'}. Requests concerning personal data should be addressed to the data protection contact indicated in the Privacy Notice.`,
      ],
    });
  } else {
    sections.push({
      heading: '1. About this deployment',
      paragraphs: [
        'This is a self-hosted installation of DOMINUS, the open-source domain investment decision-support tool. The software is distributed under the GNU Affero General Public License v3; the source code is public and you may use, study, share and modify it under that license.',
        'The person or organisation that deployed this instance is the operator of the installation and the data controller of the data stored in it. The commercial terms of the managed DOMINUS Cloud service do not apply to this deployment, and no DOMINUS Cloud subscription is active here.',
      ],
    });
    sections.push({
      heading: '2. What this deployment does with your data',
      paragraphs: [
        'Everything this instance stores — candidates, scores, portfolio entries, run history, automation journals, provider credentials — stays in the database you configured, on the machine you control. Nothing is transmitted to the DOMINUS authors.',
        'The instances that use public data sources (RDAP registries, USPTO and EUIPO trademark databases, archived web data) send requests to those services, which see the domain names and queries you submit. That is inherent to the function, not a property of this deployment.',
      ],
    });
    sections.push({
      heading: '3. Obligations that stay with you',
      paragraphs: [
        'You are responsible for the legality of the way you use the tool, for the domains you buy, for the accuracy of the data you import, and for the provider credentials you store in the credential vault.',
        'The valuation output is heuristic and conservative, and the trademark gate does not replace a legal opinion. Verify before you spend.',
      ],
    });
    sections.push({
      heading: '4. License',
      paragraphs: [
        'DOMINUS is free software under the AGPL v3. Section 13 of that license applies if you run a modified version as a network service: you must offer the corresponding source of your modifications to the users of the service. Commercial licensing is available if that obligation does not fit your deployment.',
      ],
    });
  }

  return {
    slug: 'legal-notice',
    title: cloudMode ? 'Legal notice' : 'About this deployment',
    scope: cloudMode
      ? 'This notice identifies the operator of DOMINUS Cloud, as required by art. 7 of Italian Legislative Decree 70/2003 (Consumer Code, consolidated text). It is presented in English; the Italian version prevails in case of discrepancy.'
      : 'This page describes the open-source deployment you are looking at. It is not a contract and it does not bind the DOMINUS authors: the operator of this instance is the only party responsible for it.',
    sections,
  };
}

function termsOfService(identity: LegalIdentity, cloudMode: boolean): LegalDocument {
  const sections: LegalSection[] = [];

  sections.push({
    heading: '1. Acceptance',
    paragraphs: [
      'By creating an account or using DOMINUS Cloud you accept these Terms of Service. If you do not accept them, do not use the service. If you use the service on behalf of an organisation, you confirm that you are authorised to bind that organisation.',
    ],
  });

  sections.push({
    heading: '2. The service',
    paragraphs: [
      'DOMINUS provides domain valuation, portfolio tracking, renewal verdicts and, when explicitly enabled, a post-acquisition automation pipeline. The managed service (DOMINUS Cloud) and the self-hosted community edition have the same feature set: monetisation is on hosting, never on features.',
    ],
  });

  sections.push({
    heading: '3. Accounts and security',
    paragraphs: [
      'You are responsible for the credentials of your account, for the API keys you create and for the provider credentials you store in the credential vault. Tell us promptly if you believe a key or a credential has been compromised. Team members you invite are under your control: you decide who sees which tenant data.',
      'We may suspend an account that is being used to attack the service, to circumvent usage limits, or to violate the law, and we will tell you why.',
    ],
  });

  sections.push({
    heading: '4. Acceptable use',
    paragraphs: [
      'You may not use the service to break the law, to infringe the rights of others, to send unsolicited communications, to scrape the public namespace at a rate that degrades it for others, or to attempt to gain access to data belonging to another tenant.',
    ],
  });

  sections.push({
    heading: '5. No investment advice',
    paragraphs: [
      'DOMINUS produces estimates, not advice. Valuations, buy ceilings, list prices, keep/drop verdicts and carry-cost verdicts are heuristic outputs computed from public data and from the data you provide. They can be wrong, and they are not a substitute for your own analysis. You are solely responsible for your investment decisions and for any loss resulting from them.',
      'The scoring engine is deliberately conservative: when the data is missing or a provider cannot be verified, the engine lowers the estimate or refuses to answer rather than guessing.',
    ],
  });

  sections.push({
    heading: '6. The trademark gate',
    paragraphs: [
      'Every candidate is checked against the USPTO and EUIPO trademark databases before a buy recommendation is produced, and a match blocks the recommendation. The gate cannot be bypassed. It is not a legal clearance: it reduces the risk of an infringing registration, it does not eliminate it. Conduct your own due diligence before buying.',
    ],
  });

  if (cloudMode) {
    sections.push({
      heading: '7. Automated actions',
      paragraphs: [
        'The post-acquisition automation pipeline can publish a landing page, submit it to search engines, delegate DNS, park the domain and list it on a marketplace. It ships disabled and in dry-run mode; you enable it per tenant and per step.',
        'Once enabled, the pipeline acts with the permissions of the provider accounts you connected. Any charge, listing, DNS change or message it produces is your responsibility, and you remain responsible for the domains you own. Keep the dry-run mode on until you have reviewed each step.',
      ],
    });
    sections.push({
      heading: '8. Prices, payment and taxes',
      paragraphs: [
        'Subscription prices exclude VAT. The applicable VAT is calculated and collected at checkout according to your jurisdiction. Business customers in the European Union with a valid VAT identification number are invoiced with the reverse charge mechanism, without Italian VAT. The payment provider handles the card data; the operator never sees it.',
        'Subscriptions renew automatically at the end of each paid period until you cancel. Cancellation takes effect at the end of the period already paid for, and the service stays usable until then.',
      ],
    });
    sections.push({
      heading: '9. Right of withdrawal (EU consumers)',
      paragraphs: [
        'If you are a consumer in the European Union, you have the right to withdraw from the purchase within 14 days from the conclusion of the contract, without giving a reason (art. 52 of the Italian Consumer Code).',
        'The service is a digital service supplied immediately after the contract is concluded. Under art. 59(1)(o) of the Consumer Code, the right of withdrawal is lost when you give your prior express consent to the immediate performance of the service and acknowledge that you lose the right of withdrawal once performance has begun. By accepting these terms and completing the checkout you give that consent and that acknowledgement.',
        'If you withdraw for any other reason, or before performance has begun, we refund the amounts paid, without undue delay and in any case within fourteen days, using the same means of payment you used. Statutory rights of consumers that cannot be excluded or limited remain unaffected.',
      ],
    });
    sections.push({
      heading: '10. Availability, maintenance and recovery',
      paragraphs: [
        'The service is delivered with the care of a professional service and is backed by daily backups with point-in-time recovery. Recovery objectives are documented with the service documentation. A service level agreement with committed availability applies only to Enterprise customers, by contract.',
      ],
    });
    sections.push({
      heading: '11. Suspension and termination',
      paragraphs: [
        'You may stop using the service and cancel the subscription at any time. We may suspend or terminate the service for non-payment, for a material breach of these terms that is not remedined within fifteen days of notice, or where the law requires it. On termination we keep your data for the retention period described in the Privacy Notice and then delete it.',
      ],
    });
    sections.push({
      heading: '12. Warranties and liability',
      paragraphs: [
        'The service is provided "as is". To the extent permitted by law we exclude implied warranties of merchantability, fitness for a particular purpose and non-infringement. Nothing in these terms limits liability that cannot be limited by law, including liability for intent or gross negligence.',
        'We are not liable for indirect, incidental or consequential loss, or for lost profits, arising from your use of the service, including loss caused by your investment decisions. Where liability cannot be excluded, it is limited to the total amount you paid us in the twelve months before the event giving rise to it.',
      ],
    });
    sections.push({
      heading: '13. Indemnity',
      paragraphs: [
        'You keep the responsibility for the domains you buy, for the way you use the service, and for compliance with the laws that apply to you. We do not indemnify you against claims arising from an investment decision you took with the help of the service.',
      ],
    });
    sections.push({
      heading: '14. Personal data',
      paragraphs: [
        'The processing of personal data is described in the Privacy Notice. Where we act as a processor of your personal data, the data processing agreement agreed with you prevails over this section.',
      ],
    });
    sections.push({
      heading: '15. Governing law and jurisdiction',
      paragraphs: [
        'These Terms are governed by Italian law. For consumers, the exclusive jurisdiction of the courts of the place of residence or domicile remains, where the law provides for it. For business customers, the courts of Italy have jurisdiction, without prejudice to any mandatory provision.',
      ],
    });
    sections.push({
      heading: '16. Changes to these terms',
      paragraphs: [
        'We may update these terms. The version in force is the one published in the application, with the date of the last update shown on this page. Material changes affecting paid subscriptions are notified by email at least thirty days before they take effect.',
      ],
    });
    sections.push({
      heading: '17. Contact',
      paragraphs: [
        `The operator of DOMINUS Cloud can be reached at ${identity.contactEmail || 'the contact address shown in the legal notice'}.`,
      ],
    });
  } else {
    sections.push({
      heading: '7. Licence and warranty',
      paragraphs: [
        'DOMINUS is free software provided under the GNU Affero General Public License v3, without warranty of any kind, to the extent permitted by that license. If you run a modified version as a network service, section 13 of the AGPL requires you to offer the corresponding source of your modifications to the users of that service.',
      ],
    });
    sections.push({
      heading: '8. Liability',
      paragraphs: [
        'To the extent permitted by law, the authors of DOMINUS are not liable for any damage arising from the use of the software, including investment decisions made with its help. The valuation output is heuristic and can be wrong.',
      ],
    });
    sections.push({
      heading: '9. Contact',
      paragraphs: [
        'This deployment is operated by the party that installed it. Questions about the software itself are answered in the project repository and its issue tracker; questions about this installation go to whoever deployed it.',
      ],
    });
  }

  return {
    slug: 'terms',
    title: 'Terms of Service',
    scope: cloudMode
      ? 'These Terms of Service govern the use of DOMINUS Cloud, the managed service. The self-hosted community edition is governed by its own licence, not by these terms.'
      : 'These Terms of Service describe the licence and the limits of liability of the open-source software. They do not create obligations between you and the operator of this deployment beyond those described in the licence.',
    sections,
  };
}

function privacyPolicy(identity: LegalIdentity, cloudMode: boolean): LegalDocument {
  const sections: LegalSection[] = [];

  if (cloudMode) {
    sections.push({
      heading: '1. Who is responsible for your data',
      paragraphs: [
        `The controller of the personal data processed through DOMINUS Cloud is ${identity.entityName}${identity.vatId ? ` (VAT ID ${identity.vatId})` : ''}, reachable at ${identity.privacyEmail || identity.contactEmail || 'the contact address shown in the legal notice'}.`,
        'This notice describes the processing carried out by the operator of the managed service. If you use the self-hosted community edition, your data never reaches us: that deployment is controlled by whoever installed it.',
      ],
    });
    sections.push({
      heading: '2. What we process and why',
      paragraphs: [
        'Account and team data: email address, name, role and seat membership, used to provide the service and to send the invitations you request (art. 6(1)(b) GDPR).',
        'Authentication data: API key metadata, session tokens and single sign-on identifiers, used to authenticate you and to keep tenants isolated (art. 6(1)(b) GDPR).',
        'Usage data: number of pipeline runs and API calls per tenant, used to enforce the plan limits you subscribed to (art. 6(1)(b) GDPR).',
        'Billing data: customer identifier, invoice details, tax identification number and transaction records, used to invoice you and to meet the accounting and tax obligations (art. 6(1)(c) GDPR).',
        'Service data: the domains, candidates, scores, portfolio entries, listings and automation journals you create. It is processed to provide the service and, in the case of the automation audit trail, to answer disputes about automated actions (art. 6(1)(b) and (f) GDPR).',
        'Provider credentials: the credentials you store in the credential vault are encrypted at rest and are used only to call the providers you connected (art. 6(1)(b) GDPR).',
        'Server logs: IP address, request identifiers, user agent and error traces, used to operate, secure and debug the service. They are kept for a short period and are not used for profiling (art. 6(1)(f) GDPR).',
      ],
    });
    sections.push({
      heading: '3. Sub-processors and transfers',
      paragraphs: [
        'We use a small number of sub-processors, each bound by a data processing agreement:',
      ],
      bullets: [
        'Hetzner Online GmbH (Germany) — hosting of the application and the database.',
        'Backblaze Inc. (United States) — off-host backup storage, when off-host backups are enabled.',
        'Stripe Payments Europe Ltd. (Ireland) — subscription billing and tax calculation.',
        'Okta, Inc. / Auth0 (United States) — single sign-on, for tenants that use it.',
        'Your chosen SMTP provider — delivery of the team invitations you send.',
      ],
    });
    sections.push({
      heading: '4. Cookies and similar technologies',
      paragraphs: [
        'DOMINUS does not use advertising cookies, tracking pixels or third-party analytics. The web interface stores the session token and your theme preference in your browser’s local storage, and the single sign-on flow uses a strictly necessary, short-lived session cookie. These are technical means that make the service work; they are not used to profile you and do not require consent.',
        'We keep this statement true by design: introducing any analytics or advertising script requires a consent mechanism, and the consent notice is part of the release checklist rather than a task for later.',
      ],
    });
    sections.push({
      heading: '5. How long we keep it',
      paragraphs: ['The retention periods are configurable and, by default:'],
      bullets: [
        'Sessions and API tokens: until they expire or you revoke them.',
        'Automation audit trail: 90 days.',
        'Published public scores: 90 days.',
        'Usage records: as long as the subscription is active, plus the period required by tax and accounting law for invoices.',
        'Server logs: a short, rolling period.',
        'Backups: a rolling window of about thirty days, after which the older copies are deleted.',
        'Service data you created: until you delete it, either directly or through the export and deletion functions.',
      ],
    });
    sections.push({
      heading: '6. Your rights',
      paragraphs: [
        'You have the right to access your data, to have it rectified, to have it erased, to restrict or object to the processing, to receive it in a portable format, and to complain to the supervisory authority.',
        `The supervisory authority is the ${identity.supervisoryAuthority || 'Garante per la protezione dei dati personali (Italy)'}.`,
        'You can exercise the access and portability rights yourself: the API exposes an export function that returns everything the service holds about your tenant, and a deletion function that removes it. For the remaining rights, write to the data protection contact. We answer within one month, and we may ask you to confirm your identity first.',
        'Deletion does not extend to copies that must be kept for legal reasons, such as issued invoices, or to backups that are overwritten on a rolling window; we explain this in the confirmation.',
      ],
    });
    sections.push({
      heading: '7. Automated decisions',
      paragraphs: [
        'The scoring engine evaluates domains automatically and produces valuations and verdicts. Those outputs have no legal effect and are not decisions about you: they are estimates you read and act on yourself. No decision producing legal or similarly significant effects is taken by automated means.',
      ],
    });
    sections.push({
      heading: '8. Security',
      paragraphs: [
        'Data in transit is protected with TLS. The database is isolated per tenant with row-level security in the database itself, not only in the application. Provider credentials are encrypted at rest. Backups are encrypted and, in the managed topology, copied off the application host. Access to the production systems is restricted to the people who operate them.',
      ],
    });
    sections.push({
      heading: '9. Children',
      paragraphs: [
        'The service is not directed at children and is not intended for use by them. We do not knowingly collect data from children.',
      ],
    });
    sections.push({
      heading: '10. Changes to this notice',
      paragraphs: [
        'We update this notice when the processing changes. The date of the last update is shown on this page. Material changes affecting the processing of your data are notified by email.',
      ],
    });
  } else {
    sections.push({
      heading: '1. Who is responsible for your data',
      paragraphs: [
        'This is a self-hosted installation. The party that deployed it is the data controller: your data is stored in the database you configured and never reaches the DOMINUS authors.',
        'This notice describes what the software does with the data by design, so that the operator of the deployment can fulfil their own obligations. It is not an agreement between you and the DOMINUS authors.',
      ],
    });
    sections.push({
      heading: '2. What the software processes',
      paragraphs: [
        'It processes the data you enter — candidates, scores, portfolio entries, listings, automation journals — and the credentials you store in the credential vault, in order to provide the features you use. It stores them in the database you configured.',
        'The instances that use public data sources (RDAP registries, USPTO and EUIPO trademark databases, archived web data) send requests to those services, which see the queries you submit. Those services are independent controllers for that traffic.',
      ],
    });
    sections.push({
      heading: '3. Cookies and similar technologies',
      paragraphs: [
        'DOMINUS does not use advertising cookies, tracking pixels or third-party analytics. The web interface stores the session token and your theme preference in your browser’s local storage, and the single sign-on flow uses a strictly necessary, short-lived session cookie.',
      ],
    });
    sections.push({
      heading: '4. Retention',
      paragraphs: [
        'The software keeps the data you enter until you delete it. The automation audit trail, the published public scores and the usage records are pruned on configurable schedules (90, 90 and 180 days by default). The retention periods that apply to the server logs and to the backups are the ones configured by the operator of the deployment.',
      ],
    });
    sections.push({
      heading: '5. Security',
      paragraphs: [
        'Data in transit is protected with TLS when the deployment is served over HTTPS. Provider credentials are encrypted at rest. In the managed topology, tenants are isolated with row-level security in the database itself.',
      ],
    });
    sections.push({
      heading: '6. Your rights',
      paragraphs: [
        'Because the data never leaves your deployment, you exercise your rights directly against the operator of the deployment, with the export and deletion functions the API exposes for that purpose.',
      ],
    });
  }

  return {
    slug: 'privacy',
    title: 'Privacy Notice',
    scope: cloudMode
      ? 'This notice describes how DOMINUS Cloud processes personal data, as required by art. 13 and 14 of the GDPR. It is presented in English; the Italian version prevails in case of discrepancy.'
      : 'This notice describes the data handling built into the open-source software, for the benefit of the operator of this deployment.',
    sections,
  };
}

/**
 * Assemble the legal surface for this deployment.
 *
 * Pure: it takes the operator identity and the mode as input, so it can be
 * unit-tested without touching the environment, and it is the single place
 * where the text of the three documents is assembled.
 */
export function buildLegalContent(options: LegalContentOptions): LegalContent {
  const { cloudMode } = options;
  const identity = cloudMode ? options.identity : SELF_HOSTED_IDENTITY;
  return {
    mode: cloudMode ? 'cloud' : 'community',
    identity,
    documents: [
      legalNotice(identity, cloudMode),
      termsOfService(identity, cloudMode),
      privacyPolicy(identity, cloudMode),
    ],
  };
}
