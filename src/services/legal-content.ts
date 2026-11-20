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
 * Three rules shaped this module:
 *
 * 1. **The text is data, not markup.** The documents are structured
 *    (title, scope, sections with paragraphs and bullets) so that the
 *    guardrail script (scripts/check-legal-placeholders.mjs) can read them
 *    and the SPA can render them without parsing HTML.
 *
 * 2. **The community edition is not the Cloud.** A self-hosted deployment is
 *    operated by whoever deployed it: that person is the data controller, the
 *    AGPL governs the software, and none of the Cloud commercial terms apply
 *    to them.
 *
 * 3. **A waitlist is not a shop.** DOMINUS Cloud is not on sale until the
 *    operator has a registered business, a VAT regime and a checkout that
 *    satisfies the Consumer Code. Until then the documents describe the
 *    website and the waitlist, and the paid clauses are explicitly dormant.
 *    Publishing a withdrawal policy and a price for a service nobody can buy
 *    is not harmless: it is a statement about a contract that does not exist.
 *
 * The Italian law references (art. 7 D.Lgs. 70/2003 for the electronic
 * commerce disclosure, arts. 49-59 and 128-135 of the Consumer Code for
 * consumer sales, art. 28 GDPR for the data processing agreement) describe
 * the operator's situation: the service is provided by an EU economic
 * operator subject to Italian law. The texts are drafted without formal
 * legal review - ADR-0090 records that decision and its consequences.
 */
import type { LegalIdentity } from './legal-identity.js';

/** Version of the documents below. Bumped with every substantive edit. */
export const LEGAL_DOCUMENTS_VERSION = '2026-11-20';

/** Date of the last substantive edit of the documents below. */
export const LEGAL_DOCUMENTS_UPDATED_AT = '2026-11-20';

export type LegalDocumentSlug = 'legal-notice' | 'terms' | 'privacy';

/** What the deployment is, as far as the documents are concerned. */
export type LegalServiceStatus = 'community' | 'cloud_waitlist' | 'cloud_paid';

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
  /** Whether the managed service is on sale, on a waitlist, or absent. */
  status: LegalServiceStatus;
  /** The version of the published documents. */
  version: string;
  /** The date of the last substantive edit (ISO 8601). */
  updatedAt: string;
  /** The waitlist destination, when the operator configured one. */
  waitlistUrl?: string;
  /** True when a security contact exists, so `/.well-known/security.txt` answers 200. */
  securityContactAvailable: boolean;
  identity: LegalIdentity;
  documents: LegalDocument[];
}

export interface LegalContentOptions {
  identity: LegalIdentity;
  cloudMode: boolean;
  /**
   * True only when the managed service can actually be bought. A Cloud
   * deployment that is collecting a waitlist keeps this false.
   */
  paidService?: boolean;
  /** Optional public waitlist destination. */
  waitlistUrl?: string;
  /** True when a security contact is configured and security.txt is served. */
  securityContactAvailable?: boolean;
  /** Overrides LEGAL_DOCUMENTS_UPDATED_AT; used by the launch gate. */
  updatedAt?: string;
}

const SELF_HOSTED_IDENTITY: LegalIdentity = {
  entityName: 'The operator of this deployment',
  entityKind: 'individual',
  registeredAddress: 'Not applicable - this is a self-hosted deployment',
  vatId: '',
  reaNumber: '',
  registroImprese: '',
  pec: '',
  contactEmail: '',
  privacyEmail: '',
  supervisoryAuthority: '',
  vatRegime: 'none',
};

/** The identity lines rendered in the legal notice, skipping empty fields. */
function identityLines(identity: LegalIdentity): string[] {
  const lines: string[] = [identity.entityName];
  if (identity.entityKind !== 'individual') {
    lines.push(
      identity.entityKind === 'sole_trader'
        ? 'Legal form: sole trader (ditta individuale)'
        : 'Legal form: company',
    );
  }
  if (identity.registeredAddress) lines.push(identity.registeredAddress);
  if (identity.vatId) lines.push(`VAT ID: ${identity.vatId}`);
  if (identity.registroImprese) lines.push(`Business register: ${identity.registroImprese}`);
  if (identity.reaNumber) lines.push(`REA number: ${identity.reaNumber}`);
  if (identity.pec) lines.push(`Certified email (PEC): ${identity.pec}`);
  if (identity.contactEmail) lines.push(`Contact: ${identity.contactEmail}`);
  if (identity.privacyEmail) lines.push(`Data protection contact: ${identity.privacyEmail}`);
  return lines;
}

/** How prices are described, given the operator's VAT regime. */
function vatParagraph(identity: LegalIdentity, paidService: boolean): string {
  if (!paidService) {
    return 'No paid subscription is offered at the moment. Nothing on this website is a price offer, and no payment is collected.';
  }
  if (identity.vatRegime === 'forfettario') {
    return 'The operator applies the Italian flat-rate regime. Prices are not subject to VAT (operazione fuori campo IVA). The total payable is shown before payment; consumers in Italy see the final amount, and cross-border consumer sales are not offered under this regime.';
  }
  if (identity.vatRegime === 'none') {
    return 'The operator is not subject to VAT. Prices are shown as the total payable, and the invoice states the legal basis on which VAT is not charged.';
  }
  return 'For consumers, the price shown before payment includes VAT at the rate of the consumer’s country of residence (22% in Italy). For business customers, prices are shown excluding VAT; a business in the European Union with a valid VAT identification number is invoiced under the reverse charge, without Italian VAT. The total payable, including any tax, is shown before payment.';
}

function legalNotice(
  identity: LegalIdentity,
  cloudMode: boolean,
  paidService: boolean,
  waitlistUrl: string | undefined,
): LegalDocument {
  const sections: LegalSection[] = [];

  if (cloudMode) {
    sections.push({
      heading: '1. Service provider',
      paragraphs: [
        'This website, and the DOMINUS Cloud service when it is on sale, are provided by the operator identified below. That operator is the legal person responsible for the service and for the personal data processed through it.',
        ...identityLines(identity),
      ],
    });
    sections.push({
      heading: paidService ? '2. Nature of the service' : '2. Status of the hosted service',
      paragraphs: paidService
        ? [
            'DOMINUS is a decision-support tool for domain investors. It produces valuations, buy ceilings, list prices and renewal verdicts from public data and from the data you provide. It is not an investment service, it does not manage money, and it does not buy or sell domains on your behalf unless you explicitly configure the automation pipeline with your own provider accounts.',
            'The estimates are heuristic. They are deliberately conservative and they can be wrong; the trademark gate reduces but does not eliminate legal risk. Verify before you act.',
          ]
        : [
            'DOMINUS Cloud, the managed edition, is not open for paid subscriptions yet. This website publishes information about the project and, when a destination is configured, a waitlist. No subscription can be bought here, no payment is collected, and no workspace is created through this website.',
            waitlistUrl
              ? `The waitlist is available at ${waitlistUrl}. The form names the provider that hosts it and links its privacy notice before you submit your address.`
              : 'A waitlist form is not active on this deployment. Follow the project repository for the announcement that the hosted edition is open.',
            'The self-hosted community edition is available now under the GNU Affero General Public License v3. It runs on infrastructure you control and is governed by its own licence, not by the paid Cloud terms.',
          ],
    });
    if (paidService) {
      sections.push({
        heading: '3. Prices, taxes and billing',
        paragraphs: [
          vatParagraph(identity, paidService),
          'Subscriptions renew automatically until cancelled. You can cancel at any time from the billing page; the cancellation takes effect at the end of the paid period already paid for.',
        ],
      });
    }
    sections.push({
      heading: paidService ? '4. Availability' : '3. Nature of the tool',
      paragraphs: paidService
        ? [
            'A service level agreement with committed availability applies only to Enterprise customers, by contract. For every other plan the service is provided without an uptime commitment.',
            'Section 2 explains what the estimates mean and why they are not appraisals.',
          ]
        : [
            'DOMINUS is a decision-support tool. Its output is an estimate, not an appraisal and not investment advice. It does not manage money, and it does not buy or sell domains on your behalf unless you explicitly configure the automation pipeline with your own provider accounts.',
            'The estimates are heuristic. They are deliberately conservative and they can be wrong; the trademark gate reduces but does not eliminate legal risk. Verify before you act.',
            'No availability commitment applies to this website or to the waitlist.',
          ],
    });
    sections.push({
      heading: paidService
        ? '5. Intellectual property and third-party data'
        : '4. Intellectual property and third-party data',
      paragraphs: [
        'The DOMINUS source code is licensed under the GNU Affero General Public License v3; the license text and the source are published with the software. Commercial licenses are available for organisations that need proprietary embedding.',
        'Valuations use public sources such as RDAP registries, the USPTO and EUIPO trademark databases, and archived web data. Those sources remain the property of their owners, and you are responsible for how you use the data you obtain from them.',
      ],
    });
    sections.push({
      heading: paidService ? '6. Contact' : '5. Contact',
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
        'Everything this instance stores - candidates, scores, portfolio entries, run history, automation journals, provider credentials - stays in the database you configured, on the machine you control. Nothing is transmitted to the DOMINUS authors.',
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
      ? 'This notice identifies the operator of this website and, when the managed service is on sale, of DOMINUS Cloud. It is the disclosure required by art. 7 of Italian Legislative Decree 70/2003 (the e-commerce decree), not by the Consumer Code. This English text is the only binding version.'
      : 'This page describes the open-source deployment you are looking at. It is not a contract and it does not bind the DOMINUS authors: the operator of this instance is the only party responsible for it.',
    sections,
  };
}

function termsOfService(
  identity: LegalIdentity,
  cloudMode: boolean,
  paidService: boolean,
): LegalDocument {
  const sections: LegalSection[] = [];

  if (cloudMode && !paidService) {
    sections.push({
      heading: '1. Acceptance',
      paragraphs: [
        'By using this website you accept these terms. If you do not accept them, do not use the website.',
        'These terms govern the website and the waitlist. They do not govern a paid DOMINUS Cloud subscription, because none is offered today. The paid terms will be published and separately accepted before any subscription can be bought.',
      ],
    });
    sections.push({
      heading: '2. Status of the hosted service',
      paragraphs: [
        'DOMINUS Cloud is not open for paid subscriptions. No price shown anywhere on this website is an offer, no checkout is active, and no payment is collected. A waitlist registration is not a contract for the service and does not reserve a seat, a price or a launch date.',
        'The self-hosted community edition is available now under the GNU Affero General Public License v3. Its licence, not these terms, governs your use of that software.',
      ],
    });
    sections.push({
      heading: '3. No investment advice',
      paragraphs: [
        'DOMINUS produces estimates, not advice and not an appraisal. Valuations, buy ceilings, list prices, keep/drop verdicts and carry-cost verdicts are heuristic outputs computed from public data and from the data you provide. They can be wrong, and they are not a substitute for your own analysis. You are solely responsible for your investment decisions and for any loss resulting from them.',
        'The scoring engine is deliberately conservative: when the data is missing or a provider cannot be verified, the engine lowers the estimate or refuses to answer rather than guessing.',
      ],
    });
    sections.push({
      heading: '4. The trademark gate',
      paragraphs: [
        'Every candidate is checked against the USPTO and EUIPO trademark databases before a buy recommendation is produced, and a match blocks the recommendation. The gate cannot be bypassed. It is not a legal clearance: it reduces the risk of an infringing registration, it does not eliminate it. Conduct your own due diligence before buying.',
      ],
    });
    sections.push({
      heading: '5. Acceptable use',
      paragraphs: [
        'You may not use this website to break the law, to infringe the rights of others, to send unsolicited communications, to attempt to gain access to data belonging to another person, or to interfere with the availability of the website.',
      ],
    });
    sections.push({
      heading: '6. Personal data',
      paragraphs: [
        'The processing of personal data is described in the Privacy Notice. If a waitlist form is hosted by a third party, that form names the provider and links its privacy notice before you submit your address.',
      ],
    });
    sections.push({
      heading: '7. Liability',
      paragraphs: [
        'Nothing in these terms excludes or limits liability that cannot be excluded or limited by law, including liability for death or personal injury caused by negligence, fraud, or gross negligence.',
        'Subject to that, the website and the waitlist are provided free of charge and without a warranty of uninterrupted availability. The operator is not liable for indirect or consequential loss arising from the use of the website.',
      ],
    });
    sections.push({
      heading: '8. Changes and contact',
      paragraphs: [
        'The operator may update these terms. The version in force is the one published on this page, with its version and effective date.',
        `Questions about these terms go to ${identity.contactEmail || 'the contact address shown in the legal notice'}.`,
      ],
    });

    return {
      slug: 'terms',
      title: 'Terms of Service',
      scope:
        'These terms govern this website and the waitlist while DOMINUS Cloud is not on sale. The paid subscription terms are not in force yet. This English text is the only binding version.',
      sections,
    };
  }

  if (cloudMode && paidService) {
    sections.push({
      heading: '1. Acceptance and pre-contract information',
      paragraphs: [
        'By creating an account or buying a subscription you accept these terms. If you do not accept them, do not use the service. If you use the service on behalf of an organisation, you confirm that you are authorised to bind that organisation.',
        'Before you pay, the checkout shows the service, the total price including taxes, the duration of the contract, the right of withdrawal and how to exercise it. You accept these terms and the Privacy Notice separately; a pre-ticked box is not consent.',
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
        'DOMINUS produces estimates, not advice and not an appraisal. Valuations, buy ceilings, list prices, keep/drop verdicts and carry-cost verdicts are heuristic outputs computed from public data and from the data you provide. They can be wrong, and they are not a substitute for your own analysis. You are solely responsible for your investment decisions and for any loss resulting from them.',
        'The scoring engine is deliberately conservative: when the data is missing or a provider cannot be verified, the engine lowers the estimate or refuses to answer rather than guessing.',
      ],
    });
    sections.push({
      heading: '6. The trademark gate',
      paragraphs: [
        'Every candidate is checked against the USPTO and EUIPO trademark databases before a buy recommendation is produced, and a match blocks the recommendation. The gate cannot be bypassed. It is not a legal clearance: it reduces the risk of an infringing registration, it does not eliminate it. Conduct your own due diligence before buying.',
      ],
    });
    sections.push({
      heading: '7. Automated actions',
      paragraphs: [
        'The post-acquisition automation pipeline can publish a landing page, submit it to search engines, delegate DNS, park the domain and list it on a marketplace. It ships disabled and in dry-run mode; you enable it per tenant and per step.',
        'Once enabled, the pipeline acts with the permissions of the provider accounts you connected. Any charge, listing, DNS change or message it produces is your responsibility, and you remain responsible for the domains you own. Keep the dry-run mode on until you have reviewed each step.',
      ],
    });
    sections.push({
      heading: '8. Prices, payment, VAT and invoices',
      paragraphs: [
        vatParagraph(identity, paidService),
        'The price in force is the one shown at checkout before payment. We may change the price for a future renewal; we notify you at least thirty days before the change takes effect, and you may cancel before it applies.',
        'Subscriptions renew automatically at the end of each paid period until you cancel. Cancellation takes effect at the end of the period already paid for, and the service stays usable until then. The payment provider handles the card data; the operator never sees it.',
        'A Stripe receipt is not a substitute for the invoice. The operator issues the invoices required by Italian law and collects the destination code or PEC that business customers in Italy need for electronic invoicing through SdI before enabling paid subscriptions.',
      ],
    });
    sections.push({
      heading: '9. Right of withdrawal (EU consumers)',
      paragraphs: [
        'If you are a consumer in the European Union, you have the right to withdraw from the purchase within 14 days from the conclusion of the contract, without giving a reason (art. 52 of the Italian Consumer Code).',
        'If you ask us to start the service immediately, you pay only the proportional part of the price for the service supplied before you withdraw; we refund the rest (art. 57(3) of the Consumer Code). We do not ask you to waive the right of withdrawal under art. 59(1)(o), and no such waiver applies.',
        'To withdraw, tell us at the contact address in the legal notice, or use the model form below. You may use this model form, but you are not required to:',
        'Model withdrawal form (Annex I, Part B, Italian Consumer Code). To the operator identified in the legal notice: I/We hereby give notice that I/We withdraw from my/our contract for the following service: [service]. Ordered on: [date]. Name of consumer(s): [name]. Address of consumer(s): [address]. Signature (only if this form is sent on paper): [signature]. Date: [date].',
        'We refund the amounts paid without undue delay and in any case within 14 days of the withdrawal, using the same means of payment you used, unless you expressly agree otherwise and provided that you incur no fee. We may withhold the refund until we have received the service back or you have supplied evidence of having sent it, where that is applicable.',
        'The confirmation of the contract, these terms and the withdrawal information are supplied on a durable medium (email or PDF), as the law requires. Statutory rights of consumers that cannot be excluded or limited remain unaffected.',
      ],
    });
    sections.push({
      heading: '10. Legal guarantee (consumers)',
      paragraphs: [
        'If you are a consumer, the service must conform to the contract. The legal guarantee under arts. 128-135 of the Italian Consumer Code applies, together with the remedies those articles provide (repair, replacement, price reduction or termination, according to the case).',
        'Nothing in these terms reduces the legal guarantee or the statutory rights you have as a consumer.',
      ],
    });
    sections.push({
      heading: '11. Availability, maintenance and recovery',
      paragraphs: [
        'The service is delivered with the care of a professional service and is backed by daily backups. Point-in-time recovery is available when the deployment is configured for it and is documented with the service documentation.',
        'A service level agreement with committed availability applies only to Enterprise customers, by contract. For every other plan the service is provided without an uptime commitment.',
      ],
    });
    sections.push({
      heading: '12. Suspension and termination',
      paragraphs: [
        'You may stop using the service and cancel the subscription at any time. We may suspend or terminate the service for non-payment, for a material breach of these terms that is not remedied within fifteen days of notice, or where the law requires it. On termination we keep your data for the retention period described in the Privacy Notice and then delete it.',
      ],
    });
    sections.push({
      heading: '13. Warranties and liability',
      paragraphs: [
        'Nothing in these terms excludes or limits liability for death or personal injury caused by negligence, for fraud or fraudulent misrepresentation, for gross negligence, or for any other liability that cannot be excluded or limited by law. The statutory rights of consumers, including the legal guarantee in section 10, remain unaffected.',
        'For business customers only, and to the extent permitted by law: the service is provided without implied warranties of merchantability, fitness for a particular purpose or non-infringement, and the operator is not liable for indirect, incidental or consequential loss, or for lost profits. Where liability cannot be excluded, it is limited to the total amount the business customer paid in the twelve months before the event giving rise to it.',
        'The operator is not liable for an investment decision you took with the help of the service. The estimates are inputs to your decision, not a promise of value.',
      ],
    });
    sections.push({
      heading: '14. Indemnity (business customers)',
      paragraphs: [
        'A business customer keeps the responsibility for the domains it buys, for the way it uses the service, and for compliance with the laws that apply to it. The operator does not indemnify a business customer against claims arising from an investment decision taken with the help of the service.',
      ],
    });
    sections.push({
      heading: '15. Clauses requiring specific approval (art. 1341 c.c.)',
      paragraphs: [
        'For business customers, the clauses on limitation of liability (section 13), indemnity (section 14), and governing law and jurisdiction (section 17) are specifically approved under art. 1341 c.c. A consumer is not asked to approve clauses that limit statutory rights, because those clauses do not apply to consumers.',
      ],
    });
    sections.push({
      heading: '16. Personal data',
      paragraphs: [
        'The processing of personal data is described in the Privacy Notice. The operator and a business customer may agree a data processing agreement under art. 28 GDPR; where they do, it prevails over this section.',
      ],
    });
    sections.push({
      heading: '17. Governing law, dispute resolution and jurisdiction',
      paragraphs: [
        'These terms are governed by Italian law. For consumers, the court of the place where the consumer resides or is domiciled has jurisdiction, where the law provides for it. For business customers, the courts of Italy have jurisdiction, without prejudice to any mandatory provision.',
        'If you are a consumer and a dispute arises, you may use an alternative dispute resolution (ADR) entity competent for the dispute. The European Commission’s Online Dispute Resolution platform ceased operations on 20 July 2025, so these terms do not link to it. The European Consumer Centre Italy can provide guidance on your rights and on the available ADR entities.',
      ],
    });
    sections.push({
      heading: '18. Changes to these terms',
      paragraphs: [
        'We may update these terms. The version in force is the one published in the application, with its version and effective date. Material changes affecting paid subscriptions are notified by email at least thirty days before they take effect, and you may cancel before they apply.',
      ],
    });
    sections.push({
      heading: '19. Contact',
      paragraphs: [
        `The operator of DOMINUS Cloud can be reached at ${identity.contactEmail || 'the contact address shown in the legal notice'}.`,
      ],
    });

    return {
      slug: 'terms',
      title: 'Terms of Service',
      scope:
        'These Terms of Service govern the use of DOMINUS Cloud, the managed service. The self-hosted community edition is governed by its own licence, not by these terms. This English text is the only binding version.',
      sections,
    };
  }

  // The self-hosted community edition.
  sections.push({
    heading: '1. Acceptance',
    paragraphs: [
      'By creating an account or using this deployment you accept these terms. If you do not accept them, do not use the deployment.',
    ],
  });
  sections.push({
    heading: '2. The service',
    paragraphs: [
      'DOMINUS provides domain valuation, portfolio tracking and renewal verdicts. This deployment is operated by the party that installed it; the commercial terms of DOMINUS Cloud do not apply here.',
    ],
  });
  sections.push({
    heading: '3. Acceptable use',
    paragraphs: [
      'You may not use the deployment to break the law, to infringe the rights of others, to send unsolicited communications, or to attempt to gain access to data belonging to another person.',
    ],
  });
  sections.push({
    heading: '4. No investment advice',
    paragraphs: [
      'DOMINUS produces estimates, not advice and not an appraisal. Valuations, buy ceilings, list prices and keep/drop verdicts are heuristic outputs computed from public data and from the data you provide. They can be wrong. You are solely responsible for your investment decisions.',
    ],
  });
  sections.push({
    heading: '5. The trademark gate',
    paragraphs: [
      'Every candidate is checked against the USPTO and EUIPO trademark databases before a buy recommendation is produced, and a match blocks the recommendation. The gate is not a legal clearance: it reduces the risk of an infringing registration, it does not eliminate it.',
    ],
  });
  sections.push({
    heading: '6. Licence and warranty',
    paragraphs: [
      'DOMINUS is free software provided under the GNU Affero General Public License v3, without warranty of any kind, to the extent permitted by that license. If you run a modified version as a network service, section 13 of the AGPL requires you to offer the corresponding source of your modifications to the users of that service.',
    ],
  });
  sections.push({
    heading: '7. Liability',
    paragraphs: [
      'To the extent permitted by law, the authors of DOMINUS are not liable for any damage arising from the use of the software, including investment decisions made with its help. The valuation output is heuristic and can be wrong.',
    ],
  });
  sections.push({
    heading: '8. Contact',
    paragraphs: [
      'This deployment is operated by the party that installed it. Questions about the software itself are answered in the project repository and its issue tracker; questions about this installation go to whoever deployed it.',
    ],
  });

  return {
    slug: 'terms',
    title: 'Terms of Service',
    scope:
      'These Terms of Service describe the licence and the limits of liability of the open-source software. They do not create obligations between you and the operator of this deployment beyond those described in the licence.',
    sections,
  };
}

function privacyPolicy(
  identity: LegalIdentity,
  cloudMode: boolean,
  paidService: boolean,
  waitlistUrl: string | undefined,
): LegalDocument {
  const sections: LegalSection[] = [];

  if (cloudMode) {
    sections.push({
      heading: '1. Who is responsible for your data',
      paragraphs: [
        `The controller of the personal data processed through this website${paidService ? ' and DOMINUS Cloud' : ''} is ${identity.entityName}${identity.vatId ? ` (VAT ID ${identity.vatId})` : ''}, ${identity.registeredAddress || 'at the address shown in the legal notice'}, reachable at ${identity.privacyEmail || identity.contactEmail || 'the contact address shown in the legal notice'}.`,
        'This notice describes the processing carried out by the operator of this website. If you use the self-hosted community edition, your data never reaches us: that deployment is controlled by whoever installed it.',
        'The operator has not appointed a Data Protection Officer. Data protection questions and requests go to the contact above.',
      ],
    });
    sections.push({
      heading: '2. What we process and why',
      paragraphs: paidService
        ? [
            'The categories below are the ones this service processes. Not every category applies to every visitor: a person who only reads the website has no account and no billing record.',
            'Account and team data: email address, name, role and seat membership, used to provide the service and to send the invitations you request (art. 6(1)(b) GDPR).',
            'Verification data: the address you signed up with is verified by a single-use link sent to it, so that nobody else can take your workspace. Only the hash of the token is stored, and the token is deleted when it is used (art. 6(1)(b) GDPR).',
            'Authentication data: API key metadata, session tokens and single sign-on identifiers, used to authenticate you and to keep tenants isolated (art. 6(1)(b) GDPR).',
            'Usage data: number of pipeline runs and API calls per tenant, used to enforce the plan limits you subscribed to (art. 6(1)(b) GDPR).',
            'Billing data: customer identifier, invoice details, tax identification number and transaction records, used to invoice you and to meet the accounting and tax obligations (art. 6(1)(c) GDPR).',
            'Service data: the domains, candidates, scores, portfolio entries, listings and automation journals you create. It is processed to provide the service and, in the case of the automation audit trail, to answer disputes about automated actions (art. 6(1)(b) and (f) GDPR).',
            'Provider credentials: the credentials you store in the credential vault are encrypted at rest and are used only to call the providers you connected (art. 6(1)(b) GDPR).',
            'Server logs: IP address, request identifiers, user agent and error traces, used to operate, secure and debug the service. They are kept for a short period and are not used for profiling (art. 6(1)(f) GDPR).',
          ]
        : [
            'Waitlist data: the email address you submit, the date and version of the consent you gave, and the confirmation that you opened the double opt-in link. It is used only to tell you when the hosted edition opens (art. 6(1)(a) GDPR). You can withdraw the consent at any time, and the address is then removed.',
            waitlistUrl
              ? `The waitlist is hosted at ${waitlistUrl}. The form names the provider that operates it and links its privacy notice before you submit your address.`
              : 'No waitlist form is active on this deployment, so no waitlist address is collected here.',
            'Server logs: IP address, request identifiers, user agent and error traces, used to operate, secure and debug the website. They are kept for a short period and are not used for profiling (art. 6(1)(f) GDPR).',
            'Existing accounts: if this deployment already has workspaces, it processes the account, authentication, service and billing data described in the paid version of this notice, on the same legal bases. Signup for new workspaces is closed while the paid service is not on sale.',
          ],
    });
    sections.push({
      heading: '3. Sub-processors and transfers',
      paragraphs: [
        'We use a small number of sub-processors, each bound by a data processing agreement. The current list is:',
        'Where a sub-processor is outside the European Economic Area, the transfer relies on the European Commission’s standard contractual clauses and on supplementary measures where the law requires them. A copy of the safeguards can be requested at the data protection contact.',
      ],
      bullets: [
        'Hetzner Online GmbH (Germany) - hosting of the application and the database.',
        'Backblaze Inc. (United States) - off-host backup storage, when off-host backups are enabled.',
        'Stripe Payments Europe Ltd. (Ireland) - subscription billing and tax calculation.',
        'Okta, Inc. / Auth0 (United States) - single sign-on, for tenants that use it.',
        'The SMTP provider configured by the operator - delivery of signup verification, key recovery and team invitation emails. The operator names the provider in the deployment documentation and does not use it for marketing.',
        paidService
          ? 'No other sub-processor receives personal data. A business customer may ask for the transfer safeguards and the data processing agreement at the contact above.'
          : 'No other sub-processor receives personal data while the paid service is not on sale.',
      ],
    });
    sections.push({
      heading: '4. Cookies, local storage and similar technologies',
      paragraphs: [
        'DOMINUS does not use advertising cookies, tracking pixels or third-party analytics. The browser storage that makes the service work is listed below; none of it is used to profile you.',
      ],
      bullets: [
        'dominus_api_key (sessionStorage) - the API key of the signed-in session. It is removed when the tab is closed or you sign out.',
        'dominus_theme (localStorage) - your light or dark theme preference. It contains no identifier and no personal data.',
        'dominus_pending_invite (sessionStorage) - an invitation token kept only while an invitation link survives the sign-in round trip. It is removed when it is used.',
        'A strictly necessary, short-lived session cookie is used by the single sign-on flow when SSO is enabled. It is not used for advertising or analytics.',
      ],
    });
    sections.push({
      heading: '5. How long we keep it',
      paragraphs: ['The retention periods are configurable and, by default:'],
      bullets: paidService
        ? [
            'Waitlist data, if a waitlist is also active: until you withdraw consent or after 24 months without contact, whichever comes first.',
            'Sessions and API tokens: until they expire or you revoke them.',
            'Account and service data: until you delete the workspace, plus 30 days for the deletion to propagate through backups.',
            'Automation audit trail: 90 days.',
            'Published public scores: 90 days.',
            'Usage records: as long as the subscription is active, plus the period required by tax and accounting law for invoices.',
            'Invoices and accounting records: 10 years, as Italian law requires.',
            'Server logs: 30 days.',
            'Backups: a rolling window of about thirty days, after which the older copies are deleted.',
          ]
        : [
            'Waitlist data: until you withdraw consent or after 24 months without contact, whichever comes first.',
            'Existing account and service data: until the workspace is deleted, plus 30 days for the deletion to propagate through backups.',
            'Invoices and accounting records of existing subscriptions: 10 years, as Italian law requires.',
            'Server logs: 30 days.',
            'Backups: a rolling window of about thirty days, after which the older copies are deleted.',
          ],
    });
    sections.push({
      heading: '6. Your rights',
      paragraphs: [
        'You have the right to access your data, to have it rectified, to have it erased, to restrict or object to the processing, to receive it in a portable format, and to withdraw consent at any time where the processing relies on consent. Withdrawing consent does not affect the lawfulness of the processing carried out before the withdrawal.',
        `The supervisory authority is the ${identity.supervisoryAuthority || 'Garante per la protezione dei dati personali (Italy)'}. You may also complain to the supervisory authority of your habitual residence, place of work or place of the alleged infringement.`,
        'You can exercise the access and portability rights yourself: the API exposes an export function that returns everything the service holds about your tenant, and a deletion function that removes it. The export contains your personal data and the configuration you created; the credentials themselves (your API key hashes, your invitation tokens, the encrypted provider credentials you stored) are withheld, because a copy of your data is not a copy of our secrets. For the remaining rights, write to the data protection contact. We answer within one month, and we may ask you to confirm your identity first.',
        'For waitlist data, write to the data protection contact and ask for removal. Deletion does not extend to copies that must be kept for legal reasons, such as issued invoices, or to backups that are overwritten on a rolling window; we explain this in the confirmation.',
        'Deleting your workspace also cancels your subscription: you are not invoiced for a service you cancelled.',
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
        'Data in transit is protected with TLS. Provider credentials are encrypted at rest. Tenant isolation is enforced in the application and, in the PostgreSQL deployment, additionally by row-level security policies in the database. Backups are encrypted and, in the managed topology, copied off the application host. Access to the production systems is restricted to the people who operate them.',
        'No system is perfectly secure. If a personal data breach is likely to result in a risk to your rights and freedoms, we notify the supervisory authority within 72 hours and, where the law requires it, you without undue delay.',
      ],
    });
    sections.push({
      heading: '9. Children',
      paragraphs: [
        'The service is not directed at children. It is intended for adults who can enter into a contract, and we do not knowingly collect data from anyone under 18.',
      ],
    });
    sections.push({
      heading: '10. Changes to this notice',
      paragraphs: [
        'We update this notice when the processing changes. The version in force is the one published on this page, with its version and effective date. Material changes affecting the processing of your data are notified by email.',
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
        'It processes the data you enter - candidates, scores, portfolio entries, listings, automation journals - and the credentials you store in the credential vault, in order to provide the features you use. It stores them in the database you configured.',
        'The instances that use public data sources (RDAP registries, USPTO and EUIPO trademark databases, archived web data) send requests to those services, which see the queries you submit. Those services are independent controllers for that traffic.',
      ],
    });
    sections.push({
      heading: '3. Cookies and similar technologies',
      paragraphs: [
        'DOMINUS does not use advertising cookies, tracking pixels or third-party analytics. The web interface stores the API key in sessionStorage, your theme preference in localStorage, and a pending invitation token in sessionStorage. The single sign-on flow uses a strictly necessary, short-lived session cookie when it is enabled.',
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
        'Data in transit is protected with TLS when the deployment is served over HTTPS. Provider credentials are encrypted at rest. In the PostgreSQL topology, tenants are isolated with row-level security policies in the database in addition to the application filters.',
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
      ? 'This notice describes how this website and, when it is on sale, DOMINUS Cloud process personal data, as required by art. 13 and 14 of the GDPR. This English text is the only binding version.'
      : 'This notice describes the data handling built into the open-source software, for the benefit of the operator of this deployment.',
    sections,
  };
}

/**
 * Assemble the legal surface for this deployment.
 *
 * Pure: it takes the operator identity and the mode as input, so it can be
 * unit-tested without touching the environment, and it is the single place
 * where the text of the documents is assembled.
 */
export function buildLegalContent(options: LegalContentOptions): LegalContent {
  const { cloudMode } = options;
  const paidService = cloudMode && options.paidService === true;
  const identity = cloudMode ? options.identity : SELF_HOSTED_IDENTITY;
  const status: LegalServiceStatus = !cloudMode
    ? 'community'
    : paidService
      ? 'cloud_paid'
      : 'cloud_waitlist';
  const updatedAt = options.updatedAt ?? LEGAL_DOCUMENTS_UPDATED_AT;

  return {
    mode: cloudMode ? 'cloud' : 'community',
    status,
    version: updatedAt === LEGAL_DOCUMENTS_UPDATED_AT ? LEGAL_DOCUMENTS_VERSION : updatedAt,
    updatedAt,
    ...(options.waitlistUrl ? { waitlistUrl: options.waitlistUrl } : {}),
    securityContactAvailable: options.securityContactAvailable === true,
    identity,
    documents: [
      legalNotice(identity, cloudMode, paidService, options.waitlistUrl),
      termsOfService(identity, cloudMode, paidService),
      privacyPolicy(identity, cloudMode, paidService, options.waitlistUrl),
    ],
  };
}
