#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Legal surface guardrail.
 *
 * The legal surface is the part of the product where a silent regression is
 * indistinguishable from a correct state: a page that publishes
 * `privacy@dominus.example` looks exactly like a page that publishes the
 * real address, and a missing withdrawal clause looks exactly like a
 * document that simply does not mention withdrawal. Reviewers do not notice
 * either, and neither do tests.
 *
 * So the rules that matter are checked mechanically, in the repository, on
 * every change:
 *
 *   1. no placeholder ever reaches the published documents;
 *   2. the operator identity fields art. 7 D.Lgs. 70/2003 requires are
 *      rendered by the legal notice, and the business-only fields are not
 *      demanded from a natural person;
 *   3. the clauses EU consumer and data protection law requires are present
 *      in the documents, and the clauses the operator decided not to rely on
 *      (the art. 59(1)(o) withdrawal waiver) are absent;
 *   4. a waitlist is not a shop: the paid terms are dormant until
 *      CLOUD_PAID_ENABLED is true, and the runtime enforces it;
 *   5. the legal documents are reachable from every public page: the
 *      server-rendered template carries the footer, and the SPA registers
 *      the three routes;
 *   6. the deployment surface is documented: the identity environment
 *      variables exist in the configuration and in .env.example.
 *
 * The runtime counterpart is `npm run launch:check`, which verifies the same
 * things against a running deployment, with the real configured values.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const failures = [];

function read(relPath) {
  const abs = join(root, relPath);
  if (!existsSync(abs)) {
    failures.push(`missing file: ${relPath}`);
    return '';
  }
  return readFileSync(abs, 'utf-8');
}

/* ------------------------------------------------------------------ *
 * 1. No placeholder in the published documents
 * ------------------------------------------------------------------ */
const LEGAL_SOURCE = 'src/services/legal-content.ts';
const legalSource = read(LEGAL_SOURCE);

const PLACEHOLDERS = [
  { pattern: /\bTBD\b/, what: 'an unresolved "TBD"' },
  { pattern: /\bTODO\b/, what: 'an unresolved "TODO"' },
  { pattern: /CHANGE_ME/, what: 'a "CHANGE_ME" placeholder' },
  // The "[●]" clause marker is the one rule that does not apply to the two
  // intentionally templated legal documents listed in TEMPLATE_EXEMPT_FILES.
  { pattern: /\[●\]/, what: 'an unfilled "[●]" clause', templateExempt: true },
  { pattern: /\.example\b/, what: 'a reserved ".example" domain' },
  { pattern: /privacy@dominus/, what: 'the placeholder privacy address' },
  { pattern: /lorem ipsum/i, what: 'lorem ipsum' },
  // A published "Not applicable" is a controller with no identity. It looks
  // like a filled field and satisfies nobody: art. 7 D.Lgs. 70/2003 and
  // art. 13 GDPR require a name and a contact, not a disclaimer.
  { pattern: /Not applicable/i, what: 'a "Not applicable" controller field' },
];

// A placeholder in a public page, a deployment file or a launch document is
// published exactly as written, just like one in the legal text. Scan the
// whole public surface, not only the document source.
const PLACEHOLDER_SCAN_FILES = [
  LEGAL_SOURCE,
  '.env.example',
  'frontend/index.html',
  'README.md',
  'frontend/src/pages/LandingPage.tsx',
  'src/api/views/for-sale-page.ts',
  'src/api/views/legal-footer.ts',
  'docs/releases/cloud-launch-readiness.md',
  'docs/adr/0090-legal-surface-and-launch-gate.md',
  'docs/legal/legal-surface.md',
  // These two are templates by design: "[date]", "[SMTP provider]" and
  // "[●]" are fields for the operator to fill in. They are still scanned
  // for every other placeholder (see TEMPLATE_EXEMPT_FILES below).
  'docs/legal/data-processing-agreement.md',
  'docs/legal/transfer-register.md',
];

const TEMPLATE_EXEMPT_FILES = new Set([
  'docs/legal/data-processing-agreement.md',
  'docs/legal/transfer-register.md',
]);

// Some public files intentionally *describe* placeholder-shaped strings: the
// .env.example template documents the CHANGE_ME convention and example URLs,
// the ADR and the legal-surface document explain the old placeholder
// identity, and the pricing code says "VAT not applicable". Those exact,
// documented strings are prose about placeholders, not placeholders published
// to a reader. Mask them before scanning so every other placeholder in the
// same file is still found. The masks have the same length and no newlines,
// so line numbers in the report stay accurate.
const DOCUMENTED_REFERENCES = [
  {
    file: '.env.example',
    strings: ['CHANGE_ME', 'hooks.example.com', 'dominus.example', 'smtp.example.com'],
  },
  { file: 'README.md', strings: ['.env.example'] },
  {
    file: 'docs/adr/0090-legal-surface-and-launch-gate.md',
    strings: ['privacy@dominus.example', '.env.example'],
  },
  {
    file: 'docs/legal/legal-surface.md',
    strings: ['privacy@dominus.example', '.env.example', '[●]', '"not applicable"'],
  },
  { file: 'frontend/src/pages/LandingPage.tsx', strings: ['VAT not applicable'] },
];

function maskDocumentedReferences(relPath, source) {
  const strings = DOCUMENTED_REFERENCES.find((entry) => entry.file === relPath)?.strings ?? [];
  let masked = source;
  for (const text of strings) masked = masked.split(text).join('#'.repeat(text.length));
  return masked;
}

for (const relPath of PLACEHOLDER_SCAN_FILES) {
  const rawSource = relPath === LEGAL_SOURCE ? legalSource : read(relPath);
  const source = maskDocumentedReferences(relPath, rawSource);
  for (const { pattern, what, templateExempt } of PLACEHOLDERS) {
    if (templateExempt && TEMPLATE_EXEMPT_FILES.has(relPath)) continue;
    const match = source.match(pattern);
    if (match) {
      const line = source.slice(0, match.index).split('\n').length;
      failures.push(`${relPath}:${line} contains ${what} - it would be published as-is`);
    }
  }
}

/* ------------------------------------------------------------------ *
 * 2. The identity fields the law requires are rendered
 * ------------------------------------------------------------------ */
const REQUIRED_IDENTITY_RENDERINGS = [
  { field: 'tradingName', what: 'trading name of the operator' },
  { field: 'entityKind', what: 'legal form of the operator' },
  { field: 'legalForm', what: 'exact legal form of the operator' },
  { field: 'shareCapital', what: 'share capital of the operator' },
  { field: 'registeredAddress', what: 'registered address' },
  { field: 'vatId', what: 'VAT identification number' },
  { field: 'registroImprese', what: 'business register office' },
  { field: 'reaNumber', what: 'business register number' },
  { field: 'pec', what: 'certified electronic address' },
  { field: 'contactEmail', what: 'contact address' },
  { field: 'privacyEmail', what: 'data protection contact' },
];

for (const { field, what } of REQUIRED_IDENTITY_RENDERINGS) {
  if (!legalSource.includes(`identity.${field}`)) {
    failures.push(`${LEGAL_SOURCE} does not render the ${what} (identity.${field})`);
  }
}

/* ------------------------------------------------------------------ *
 * 3. The clauses the law requires, and the waiver that must be absent
 * ------------------------------------------------------------------ */
const REQUIRED_CLAUSES = [
  { pattern: /right of withdrawal/i, what: 'the right of withdrawal' },
  { pattern: /14 days/i, what: 'the 14-day withdrawal period' },
  { pattern: /art\. 57\(3\)/, what: 'the pro-rata rule of art. 57(3) Consumer Code' },
  { pattern: /arts?\. 128-135/, what: 'the consumer legal guarantee (arts. 128-135)' },
  { pattern: /reverse charge/i, what: 'the reverse charge mechanism' },
  { pattern: /SdI/, what: 'the Italian e-invoicing system' },
  { pattern: /sub-processor/i, what: 'the sub-processor list' },
  { pattern: /standard contractual clauses/i, what: 'the transfer safeguards' },
  { pattern: /supervisory authority/i, what: 'the supervisory authority' },
  { pattern: /art\. 7/, what: 'the art. 7 D.Lgs. 70/2003 reference' },
  { pattern: /art\. 1341/, what: 'the art. 1341 c.c. specific-approval clause' },
  { pattern: /not an appraisal/i, what: 'the "not an appraisal" disclaimer' },
  { pattern: /art\. 13 and 14 of the GDPR/i, what: 'the arts. 13-14 GDPR reference' },
  { pattern: /only binding version/i, what: 'the language-prevalence statement' },
  { pattern: /do not ask you to waive/i, what: 'the refusal of the art. 59(1)(o) waiver' },
  { pattern: /source of the version/i, what: 'the AGPL §13 source offer' },
  { pattern: /data-sources page/i, what: 'the data-source attribution reference' },
  { pattern: /Offer enquiries/i, what: 'the offer-lead processing section' },
  { pattern: /Public scores/i, what: 'the public-score processing section' },
  { pattern: /24 months after the end of the billing period/i, what: 'the usage-record retention limit' },
  { pattern: /AES-256-GCM/i, what: 'the credential-encryption mechanism' },
  { pattern: /at least 18 years old/i, what: 'the age statement' },
];

// Claims that were removed because the implementation does not support them.
const FORBIDDEN_CLAIMS = [
  { pattern: /withhold the refund until/i, what: 'the goods-style refund withholding' },
  { pattern: /same feature set/i, what: 'the false parity of Community and Cloud' },
  { pattern: /may agree a data processing agreement/i, what: 'the optional DPA' },
  { pattern: /repair, replacement, price reduction/i, what: 'goods remedies for a digital service' },
];
for (const { pattern, what } of FORBIDDEN_CLAIMS) {
  if (pattern.test(legalSource)) {
    failures.push(`${LEGAL_SOURCE} still contains ${what}`);
  }
}

for (const { pattern, what } of REQUIRED_CLAUSES) {
  if (!pattern.test(legalSource)) {
    failures.push(`${LEGAL_SOURCE} does not mention ${what}`);
  }
}

// The waiver text is the defect this release removed. A document that
// claims the consumer loses the withdrawal right once performance begins is
// wrong for a service supplied over time, and wrong for the operator's
// stated policy even where it could be used.
const WAIVER_CLAIM = /you (?:lose|will lose) the right of withdrawal/i;
if (WAIVER_CLAIM.test(legalSource)) {
  failures.push(
    `${LEGAL_SOURCE} claims the consumer loses the right of withdrawal - the operator does not rely on art. 59(1)(o)`,
  );
}

const BILLING_SERVICE = 'src/services/billing-service.ts';
const billingService = read(BILLING_SERVICE);
if (WAIVER_CLAIM.test(billingService)) {
  failures.push(
    `${BILLING_SERVICE} claims the consumer loses the right of withdrawal - the checkout must not use the art. 59(1)(o) waiver`,
  );
}
if (!billingService.includes('proportional part')) {
  failures.push(`${BILLING_SERVICE} does not state the pro-rata refund at checkout`);
}

// The launch document must not describe the art. 59(1)(o) waiver as a
// checkout step. The operator keeps the 14-day withdrawal right and charges
// only for the service already supplied (art. 57(3)).
const LAUNCH_READINESS = 'docs/releases/cloud-launch-readiness.md';
const launchReadiness = read(LAUNCH_READINESS);
for (const { pattern, what } of [
  {
    pattern: /art\.\s*59\(1\)\(o\)\s+withdrawal\s+consent/i,
    what: 'a claim that art. 59(1)(o) withdrawal consent is collected',
  },
  {
    pattern: /art\.\s*59\(1\)\(o\)\s+consent\s+is\s+taken\s+at\s+checkout/i,
    what: 'a claim that art. 59(1)(o) consent is taken at checkout',
  },
]) {
  if (pattern.test(launchReadiness)) {
    failures.push(
      `${LAUNCH_READINESS} contains ${what} - the operator does not rely on the art. 59(1)(o) withdrawal waiver`,
    );
  }
}

// An Italian S.r.l. is a company and cannot use the forfettario VAT regime.
// The identity configuration must validate that cross-field rule; a check
// that only looks at each field in isolation lets the impossible pair boot.
const LEGAL_IDENTITY = 'src/services/legal-identity.ts';
const legalIdentity = read(LEGAL_IDENTITY);
if (!legalIdentity.includes('forfettario') || !legalIdentity.includes('company')) {
  failures.push(
    `${LEGAL_IDENTITY} does not validate that a company (S.r.l.) cannot use the forfettario VAT regime`,
  );
}

/* ------------------------------------------------------------------ *
 * 4. A waitlist is not a shop
 * ------------------------------------------------------------------ */
const CONFIG = 'src/config.ts';
const config = read(CONFIG);
const INDEX = 'src/index.ts';
const indexSource = read(INDEX);
const BILLING_ROUTE = 'src/api/routes/billing.ts';
const billingRoute = read(BILLING_ROUTE);
const AUTH_ROUTE = 'src/api/routes/auth.ts';
const authRoute = read(AUTH_ROUTE);

if (!config.includes('CLOUD_PAID_ENABLED')) {
  failures.push(`${CONFIG} does not declare CLOUD_PAID_ENABLED`);
}
if (!indexSource.includes("missingIdentityFields(legalContent.identity, { paidService: true })")) {
  failures.push(
    `${INDEX} does not fail closed on an incomplete identity when CLOUD_PAID_ENABLED=true`,
  );
}
if (!billingRoute.includes('CHECKOUT_DISABLED')) {
  failures.push(`${BILLING_ROUTE} does not close checkout while the deployment is not on sale`);
}
if (!authRoute.includes('SIGNUP_CLOSED')) {
  failures.push(`${AUTH_ROUTE} does not close self-serve signup while the deployment is not on sale`);
}

// A first-party contract ledger is the evidence behind the consumer clauses.
// Its absence would turn the terms into promises without proof.
if (!indexSource.includes('setContractService')) {
  failures.push(`${INDEX} does not configure the contract acceptance ledger at boot`);
}
if (!billingRoute.includes('requireCheckout')) {
  failures.push(`${BILLING_ROUTE} does not require contract acceptance before checkout`);
}
const CONTRACT_SERVICE = 'src/services/contract-service.ts';
if (!read(CONTRACT_SERVICE).includes('ContractAcceptanceError')) {
  failures.push(`${CONTRACT_SERVICE} does not fail closed when acceptance is missing`);
}

// A price is a statement about a contract. The landing page may only publish
// one when the server says the hosted edition is on sale.
const LANDING_PAGE = 'frontend/src/pages/LandingPage.tsx';
const landingPage = read(LANDING_PAGE);
if (!landingPage.includes('useLegalContent')) {
  failures.push(`${LANDING_PAGE} does not read the service status from the server`);
}
if (!landingPage.includes("status === 'cloud_paid'")) {
  failures.push(`${LANDING_PAGE} does not gate the pricing section on cloud_paid`);
}

/* ------------------------------------------------------------------ *
 * 5. The documents are reachable from every public page
 * ------------------------------------------------------------------ */
const TEMPLATE = 'src/api/views/page-template.ts';
const template = read(TEMPLATE);
if (!template.includes('legalFooterHtml')) {
  failures.push(`${TEMPLATE} does not render the legal footer - the public pages would not identify the operator`);
}

const FOOTER = 'src/api/views/legal-footer.ts';
const footer = read(FOOTER);
for (const route of ['/terms', '/privacy', '/legal-notice']) {
  if (!footer.includes(`href="${route}"`)) {
    failures.push(`${FOOTER} does not link to ${route}`);
  }
}
if (!footer.includes('sourceCodeUrl')) {
  failures.push(`${FOOTER} does not link the AGPL §13 source offer`);
}
if (!footer.includes('identityPublished')) {
  failures.push(`${FOOTER} publishes a generic operator in community mode`);
}

const SPA_FOOTER = 'frontend/src/components/LegalFooter.tsx';
const spaFooter = read(SPA_FOOTER);
if (!spaFooter.includes('sourceCodeUrl')) {
  failures.push(`${SPA_FOOTER} does not link the AGPL §13 source offer`);
}

const MAIN_TSX = 'frontend/src/main.tsx';
const mainTsx = read(MAIN_TSX);
for (const route of ['terms', 'privacy', 'legal-notice']) {
  if (!mainTsx.includes(`path="${route}"`)) {
    failures.push(`${MAIN_TSX} does not register the /${route} route`);
  }
}

const PUBLIC_ROUTER = 'src/api/public-router.ts';
const publicRouter = read(PUBLIC_ROUTER);
if (!publicRouter.includes("router.get('/legal'")) {
  failures.push(`${PUBLIC_ROUTER} does not serve /public/legal`);
}
if (!publicRouter.includes('createSecurityTxtHandler')) {
  failures.push(`${PUBLIC_ROUTER} does not serve /.well-known/security.txt`);
}
if (!indexSource.includes("'/.well-known/security.txt'")) {
  failures.push(`${INDEX} does not mount /.well-known/security.txt`);
}

/* ------------------------------------------------------------------ *
 * 6. The deployment surface is documented
 * ------------------------------------------------------------------ */
const ENV_EXAMPLE = '.env.example';
const envExample = read(ENV_EXAMPLE);

const IDENTITY_VARS = [
  'LEGAL_ENTITY_NAME',
  'LEGAL_TRADING_NAME',
  'LEGAL_ENTITY_KIND',
  'LEGAL_LEGAL_FORM',
  'LEGAL_SHARE_CAPITAL',
  'LEGAL_REGISTERED_ADDRESS',
  'LEGAL_VAT_ID',
  'LEGAL_REA_NUMBER',
  'LEGAL_REGISTRO_IMPRESE',
  'LEGAL_PEC',
  'LEGAL_VAT_REGIME',
  'LEGAL_CONTACT_EMAIL',
  'LEGAL_PRIVACY_EMAIL',
  'LEGAL_SUPERVISORY_AUTHORITY',
  'SECURITY_CONTACT_EMAIL',
  'SOURCE_CODE_URL',
];

for (const name of IDENTITY_VARS) {
  if (!config.includes(name)) {
    failures.push(`${CONFIG} does not declare ${name}`);
  }
  if (!envExample.includes(name)) {
    failures.push(`${ENV_EXAMPLE} does not document ${name}`);
  }
}

for (const name of ['CLOUD_PAID_ENABLED', 'CLOUD_WAITLIST_URL']) {
  if (!config.includes(name)) {
    failures.push(`${CONFIG} does not declare ${name}`);
  }
  if (!envExample.includes(name)) {
    failures.push(`${ENV_EXAMPLE} does not document ${name}`);
  }
}

/* ------------------------------------------------------------------ *
 * 7. What the public pages say is what the engine does
 * ------------------------------------------------------------------ */
const PUBLIC_VIEWS = [
  'src/api/views/domain-page.ts',
  'src/api/views/score-page.ts',
  'src/api/views/compare-page.ts',
  'src/api/views/for-sale-page.ts',
  'src/api/views/jsonld.ts',
];
for (const relPath of PUBLIC_VIEWS) {
  const source = read(relPath);
  for (const { pattern, what } of [
    { pattern: /Free domain appraisal/i, what: 'the "free domain appraisal" claim' },
    { pattern: /Appraised List Price/i, what: 'the "appraised list price" label' },
    { pattern: /['"]@type['"]\s*:\s*['"]AggregateRating['"]/i, what: 'a fabricated aggregate rating' },
    { pattern: /\bfunction\s+(?:reviewJsonLd|productJsonLd)\b/, what: 'a product offer built from an estimate' },
  ]) {
    if (pattern.test(source)) {
      failures.push(`${relPath} contains ${what}`);
    }
  }
}
if (/trademark clearance/i.test(landingPage)) {
  failures.push(`${LANDING_PAGE} claims trademark clearance - the gate performs a screening`);
}
const readme = read('README.md');
for (const { pattern, what } of [
  { pattern: /better domain purchase, portfolio, and pricing decisions than the market average/i, what: 'an unbacked comparison with the market average' },
  { pattern: /more conservative than commercial appraisal tools/i, what: 'an unbacked comparison with commercial tools' },
  { pattern: /single database dump/i, what: 'an undocumented Cloud-to-community migration path' },
]) {
  if (pattern.test(readme)) failures.push(`README.md contains ${what}`);
}

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */
if (failures.length > 0) {
  console.error(`check-legal-placeholders: FAILED (${failures.length} problem(s))`);
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    '\nThe legal surface is published as written. A placeholder or a missing ' +
      'clause is a compliance defect, not a typo - fix the document, not the check.',
  );
  process.exit(1);
}

console.log(
  `check-legal-placeholders: OK - ${PLACEHOLDERS.length} placeholder patterns across ` +
    `${PLACEHOLDER_SCAN_FILES.length} files, ${REQUIRED_CLAUSES.length} required clauses, ` +
    `${IDENTITY_VARS.length} identity variables`,
);
