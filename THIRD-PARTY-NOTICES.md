# Third-Party Notices

DOMINUS is licensed under the **GNU Affero General Public License v3 only**
(see [LICENSE](LICENSE)). This file lists the third-party components bundled
or referenced by DOMINUS and their licenses, as required by the respective
license terms (in particular Apache-2.0 section 4(d) and LGPL-3.0).

## Runtime dependencies (backend)

| Package | License | Note |
|---------|---------|------|
| better-sqlite3 | MIT | |
| commander | MIT | |
| cors | MIT | |
| dotenv | BSD-2-Clause | |
| express | MIT | |
| express-rate-limit | MIT | |
| ioredis | MIT | |
| jose | MIT | |
| lru-cache | BlueOak-1.0.0 | |
| node-cron | ISC | |
| node-notifier | MIT | |
| pino | MIT | |
| psl | MIT | |
| stripe | MIT | |
| zod | MIT | |
| pg | MIT | Optional: PostgreSQL driver |
| sharp | Apache-2.0 | Optional: image processing. **Bundles libvips (LGPL-3.0-or-later) as a native binary.** The LGPL component is dynamically linked and may be replaced by rebuilding sharp; full license text: https://www.gnu.org/licenses/lgpl-3.0.html |

## Runtime dependencies (frontend)

All frontend dependencies are MIT, ISC, or Apache-2.0 (React, React Router,
TanStack Query/Table, Recharts, Radix UI, Tailwind CSS, Vite, Vitest, and
related tooling). Apache-2.0 components: `class-variance-authority`,
TypeScript, and `@vitejs/plugin-react`.

## Data sources

| Data | Source | License / Terms |
|------|--------|-----------------|
| Trademark data | USPTO public API, EUIPO OAuth2 API | Public government data; no redistribution restrictions |
| RDAP availability | rdap.org (bootstrap service), IANA RDAP bootstrap registry | Public infrastructure; see https://rdap.org and https://data.iana.org/rdap/dns.json |
| Parking IP ranges | `src/providers/dns/parking-ips.json` | Public IP range facts (ARIN/RIR allocations); facts are not copyrightable |
| Comparable sales (optional local file) | User-provided `COMPS_DATA_PATH` (e.g., NameBio export) | If NameBio data is used, NameBio's data terms require attribution — see https://namebio.com/terms |
| Keyword volumes (optional local file) | User-provided `KEYWORD_DATA_PATH` | Google Keyword Planner data is subject to Google Ads Terms of Service; redistribution is not permitted. DOMINUS ships **synthetic sample data only** (`examples/keywords-sample.json`) |

## Compliance notes

- **LGPL-3.0 (libvips via sharp)**: compatible with AGPL-3.0. The obligation
  is to preserve the license notice and allow replacement of the library —
  satisfied because sharp is an optional, dynamically-linked native addon.
- **License gate in CI**: the `license.yml` workflow fails builds that add
  dependencies outside the approved list (MIT, ISC, BSD, Apache-2.0,
  BlueOak-1.0.0, 0BSD, LGPL-3.0-or-later). GPL-2.0/3.0-only dependencies are
  rejected because they cannot be re-licensed under DOMINUS's commercial
  terms.

*This file is regenerated and reviewed at each release. Deps are verified by
`npm run license:check` (backend) and `npm run license:check:frontend`.*
