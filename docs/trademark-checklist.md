# Trademark Protection Checklist

AGPL v3 protects the code; it does **not** protect the "DOMINUS" brand.
This checklist is the owner's action plan for brand protection. All steps
below are external to the repository and optional; the repository-side
policy (README "Trademark" section) applies regardless.

## Why it matters

A competitor may legally fork the AGPL codebase and operate a competing
service (the license permits it). What they may **not** do is:

- claim the "DOMINUS" name or logo as their own;
- imply affiliation with or endorsement by this project;
- hold themselves out as the official project.

A registered trademark turns that prohibition into an enforceable right.
Without registration, enforcement depends on passing-off / unfair
competition law, which is weaker and jurisdiction-dependent.

## Checklist

### 1. Name clearance (before filing)

- [ ] Run a search on the EUIPO eSearch plus database (EU trade marks)
- [ ] Run a search on the USPTO TESS/TSDR (US marks)
- [ ] Run a search for identical marks on WIPO Global Brand Database
- [ ] Check domain registrations `dominus.xxx` and social handles
- [ ] Record conflicting marks and their goods/services classes

### 2. Classes

The tool is a software-as-a-service and downloadable software:

- **Class 9** — downloadable software (app/program)
- **Class 42** — SaaS, platform-as-a-service, domain-name research services
- **Class 36** — domain name valuation/brokerage services (optional)

Filing in class 42 is the minimum; 9+42 covers most real-world uses.

### 3. Filing

- **EUIPO** (EU trade mark, ~€850 for 3 classes, covers all EU):
  https://euipo.europa.eu — single application, ~4-5 month registration
- **USPTO** (US, ~$250-350/class, TEAS Plus): https://www.uspto.gov
- **WIPO** (Madrid Protocol international route) if expansion beyond EU/US
- [ ] Decide on a figurative mark (logo) vs word mark (name only) — file
  the word mark first; the logo can be a second filing

### 4. Post-filing

- [ ] Add the ™ symbol immediately; use ® only after registration
- [ ] Monitor EUIPO/USPTO watch services for conflicting applications
- [ ] Re-file the trademark checklist entry in the repo CHANGELOG on
  registration
- [ ] Update README's Trademark section once registered (® and registration
  number)

### 5. Enforcement (if infringed)

- [ ] Cease-and-desist via EUIPO/USPTO legal channels
- [ ] GitHub DMCA takedown / trademark complaint for impersonating repos
- [ ] Cloud marketplace takedowns (Docker Hub, npm name squatting) via
  platform complaint processes

---

*Repository-side policy lives in README.md → License → Trademark. This
checklist is guidance, not legal advice.*
