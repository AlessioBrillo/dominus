---
name: Custom provider request
about: Request a new provider implementation (registrar, keyword source, trademark DB, etc.)
title: ''
labels: provider
assignees: ''

---

## Provider Type

<!-- Which interface would this implement? See src/providers/ for existing patterns -->
- [ ] DnsProvider
- [ ] RdapProvider
- [ ] TrademarkProvider
- [ ] KeywordProvider
- [ ] CompsProvider
- [ ] WhoisProvider
- [ ] RegistrarProvider

## Provider Details

- Name:
- Website / API docs:
- Pricing model: <!-- free / freemium / paid -->
- Authentication: <!-- none / API key (free) / OAuth2 -->

## API Characteristics

- Rate limits:
- Response format: <!-- JSON / XML / CSV / other -->
- Availability SLA:

## Why is this provider valuable?

What data or capability would it add that DOMINUS currently lacks?

## Implementation notes

- Has this provider been tested manually? <!-- yes / no / links to docs -->
- Does it require a new `.env` variable? <!-- if yes, suggest name -->
- Is there an existing wrapper or SDK? <!-- npm package, client lib -->

## Would you implement it?

Are you willing to submit a pull request for this provider?
