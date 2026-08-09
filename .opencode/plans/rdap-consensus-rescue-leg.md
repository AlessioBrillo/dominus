# PLAN — RDAP Consensus Rescue Leg & Startup Probe (ADR-0051)

Branch: `feat/rdap-consensus-rescue-leg` (già creato da master)
Target di merge: `master` via squash-merge.
Gate di qualità: `npm run preflight` equivalente — typecheck, lint, test, db:sync:check, check:image-pins (non tocca immagini).

## Razionale (gap chiusi)

1. ADR-0050 §6 promette uno startup probe del secondo leg RDAP; mai implementato (solo DNS ha `probeConsensusProvider`).
2. `RDAP_CONSENSUS_TIMEOUT_MS` è dead config: mai passato al provider di consenso (`FailoverRdapProvider.fromConfig` hardcode `DEFAULT_RDAP_TIMEOUT_MS`).
3. La gate 2-of-2 non ha rescue path: secondario flaky → ogni Available degradato a Unknown. Il DNS ha la rescue ADR-0045; RDAP no. La WHOIS race (ADR-0035) è il terzo canale già pagato.

## Decisioni utente

- Scope completo (ADR + rescue WHOIS opt-in + probe + fix knob + test).
- Gate RDAP resta opt-in (`RDAP_CONSENSUS_ENABLED=false` default).
- Eseguire l'intero workflow git fino al merge.

## File per commit (4 commit atomici)

### Commit 1 — docs(adr)
- **ADD** `docs/adr/0051-rdap-consensus-rescue-and-probe.md` (contenuto MADR completo già redatto: Context 3 gap, Decision 1/2/3, Options rejected, Consequences, Risks, Related ADRs).
- **EDIT** `docs/adr/README.md` — riga indice: `| [0051](0051-rdap-consensus-rescue-and-probe.md) | RDAP consensus rescue leg and startup probe — gap closure for ADR-0050 | 2026-08-10 | Accepted |`
- Messaggio: `docs(adr): add ADR-0051 RDAP consensus rescue and probe`

### Commit 2 — build/config (fix knob dead)
- **EDIT** `src/config.ts` — dopo `RDAP_CONSENSUS_ENABLED` (riga ~721) aggiungere:
  ```ts
  RDAP_CONSENSUS_RESCUE_WHOIS_ENABLED: z.coerce.boolean().default(false),
  ```
  con doc comment: opt-in, richiede whoisProvider configurato, apply solo alla classe unverifiable; mai sui veto Registered (ADR-0051 §3).
- **EDIT** `src/config.test.ts` — aggiungere `'RDAP_CONSENSUS_RESCUE_WHOIS_ENABLED'` a `ENV_KEYS` del describe ADR-0050 (riga ~323); nuovo test: default false; nuovo test: `'true'` → true.
- **EDIT fixture** (aggiungere `RDAP_CONSENSUS_RESCUE_WHOIS_ENABLED: false,` accanto a `RDAP_CONSENSUS_ENABLED` in OGNI makeConfig/Config literal — la chiave è required nel tipo inferred):
  - `src/watchlist/__tests__/watchlist-service.test.ts` (~riga 113)
  - `src/cli/__tests__/index.test.ts` (~103)
  - `src/cli/__tests__/health-command.test.ts` (~98)
  - `src/cli/__tests__/providers-command.test.ts` (~99)
  - `src/scheduler/__tests__/scheduler-service.test.ts` (~102)
  - `src/api/__tests__/providers-route.test.ts` (~99)
  - `src/portfolio/__tests__/renewal-alert-engine.test.ts` (~119)
  - `src/notifiers/__tests__/notifier-router.test.ts` (~110)
  - `src/app/__tests__/provider-factory.test.ts` (~115) — anche sezione makeConfig
  - `src/app/__tests__/composition-root.test.ts` (~462) — verificare se literal o env
  - altri file con `RDAP_CONSENSUS_ENABLED` nei literal (grep per trovarli tutti)
- **EDIT** `.env.example` — dopo riga 200 (`RDAP_CONSENSUS_ENABLED`): `# RDAP_CONSENSUS_RESCUE_WHOIS_ENABLED=false` con commento (rescue WHOIS opt-in, ADR-0051).
- Messaggio: `build(rdap): add consensus rescue flag and lock timeout fixture` — oppure `feat(rdap): ...`. Scegliere `feat(rdap)` per coerenza con history.

### Commit 3 — feat(rdap) rescue leg (codice+TDD)
- **EDIT** `src/pipeline/stage.ts` — `RdapConsensusStats` + campo:
  ```ts
  tertiaryRescued?: number;
  ```
  (mirror `DnsConsensusStats.tertiaryRescued`, commento ADR-0051).
- **EDIT** `src/pipeline/stages/rdap-confirmation-stage.ts`:
  - `RdapConsensusConfig` + `rescueWhoisProvider?: WhoisProvider` (commento: opt-in ADR-0051 §3, solo per unverifiable di seconda leg, mai per veto Registered).
  - In `#verifyConsensus`, ciclo sui risultati della seconda leg: caso `result === undefined` o `status !== Available && status !== Registered` (Unknown):
    se `cfg.rescueWhoisProvider` → race WHOIS con `Promise.race` + `AbortSignal.timeout(this.whoisBudgetMs)` (pattern identico a `#checkAvailability` righe 366-376, budget = whoisBudgetMs dello stage, default 1000):
      - `whois.available === true` → `survivor.add`, `stats.verified++`, `stats.tertiaryRescued = (stats.tertiaryRescued ?? 0) + 1`
      - `whois.available === false` → `stats.disagreed++` (registered wins, log warn)
      - timeout/error → `stats.unverifiable++` (invariato)
    altrimenti `stats.unverifiable++` (comportamento ADR-0050 invariato).
  - Il veto `Registered` della seconda leg resta invariato (nessuna rescue).
- **TEST** `src/pipeline/stages/__tests__/rdap-confirmation-stage.test.ts` — nuova describe `(WHOIS rescue leg, ADR-0051)` con helper `consensusStageWithRescue(secondary, whoisProvider)` che passa il config con `rescueWhoisProvider`:
  - rescues un Available quando secondario throw (tertiaryRescued=1, verified=1, passed)
  - veto quando WHOIS dice registered (disagreed=1, filtered, rdapStatus Unknown)
  - resta unverifiable quando WHOIS timeout/error (unverifiable=1)
  - NON consulta WHOIS quando il secondario conferma Available (whoisProvider non chiamato)
  - NON consulta WHOIS su veto Registered del secondario (whoisProvider non chiamato)
  - stats con `tertiaryRescued` assente quando nessuna rescue (regressione formato stats esistenti: i test ADR-0050 usano `toEqual` — verificare che toEqual con undefined non rompa: `tertiaryRescued` undefined viene omesso da toEqual? NO — `toEqual({verified:1,...})` vs oggetto con `tertiaryRescued: undefined` → toEqual IGNORA undefined in vitest? vitest toEqual tratta `undefined` come uguale a proprietà assente. Verificare in esecuzione; in caso, usare `toMatchObject` nei nuovi test e lasciare vecchi invariati.)
- Messaggio: `feat(rdap): WHOIS tertiary rescue for the 2-of-2 consensus gate`

### Commit 4 — feat(rdap) timeout wire + startup probe
- **EDIT** `src/providers/rdap/failover-rdap-provider.ts` — `fromConfig` firma: aggiungere param `timeoutMs: number = DEFAULT_RDAP_TIMEOUT_MS` (dopo `agentPool` o prima: mantenere compatibilità chiamate esistenti — quelle con 5 argomenti posizionali; nuovo param in coda). Passarlo a `new PublicRdapProvider(url, name, limiter, timeoutMs, tlds, agentPool)` (riga ~147).
- **EDIT** `src/app/provider-factory.ts` — `createRdapConsensusConfig`: `FailoverRdapProvider.fromConfig([{url: endpoint}], rateLimiter, undefined, breakers.perServer, rdapAgentPool, config.RDAP_CONSENSUS_TIMEOUT_MS)`.
- **ADD** `probeRdapConsensusEndpoint(config, provider)` in provider-factory (export, mirror `probeConsensusProvider` riga 526): se `!config.RDAP_CONSENSUS_ENABLED` return; `provider.confirm('<dominio-probe>', AbortSignal.timeout(config.RDAP_CONSENSUS_TIMEOUT_MS)).catch(...)` con log error prominente e `.catch` che non rigetta (non-fatal). Domanda di design: dominio di probe — DNS usa `validateResolverGroups` (domini interni). Per RDAP usare un dominio noto .com mai registrabile? NO: query RDAP su dominio reale al boot. Meglio: probe su endpoint con request di bootstrap? Semplice e sicuro: `confirm('example.com')` fallirà su rdap.org? no, example.com è registrato → risposta definitiva Registered → ok (qualunque risposta definitiva = endpoint vivo; errore = morto). Non si usa per verdetto.
  - ATTENZIONE rate-limit: la probe consuma 1 token dal bucket rdap-consensus al boot — accettabile e documentato.
- **EDIT** `src/app/composition-root.ts` — dopo `createRdapConsensusConfig` (riga ~629-633): `if (rdapConsensusConfig !== undefined) probeRdapConsensusEndpoint(config, rdapConsensusConfig.secondaryProvider);` + import.
- **TEST** `src/app/__tests__/provider-factory.test.ts` — in describe `createRdapConsensusConfig (ADR-0050)`: nuovo test: fromConfig riceve `RDAP_CONSENSUS_TIMEOUT_MS` (spy su fromConfig o via `(provider as any)`? meglio: mock statico di FailoverRdapProvider.fromConfig = vi.fn → assert chiamato con timeoutMs). Nuovo test probe: conferma non rigetta con provider che risolve; conferma log error con provider che rigetta (spy su getLogger().error).
- Messaggio: `feat(rdap): wire consensus timeout and probe the second leg at boot`

## Verifica finale (prima del push)
```
npm run typecheck
npm run lint
npm test
npm run db:sync:check
npm run check:image-pins
```
+ `git diff --check`; controllare `git status` per file non intenzionali.

## Flusso git
```
git checkout -b feat/rdap-consensus-rescue-leg   # FATTO
git add <files> && git commit -m "<type>(<scope>): <desc>"   # 4 commit
git push -u origin feat/rdap-consensus-rescue-leg
gh pr create --title "<conventional-commit-title>" --body "<template repo>"
# attesa CI (matrix Node 20/22 ubuntu + 22/24 windows); fix eventuali rossi con nuovi commit
gh pr merge --squash --delete-branch
```
Messaggi secondo convenzioni repo: imperative present tense, ≤50 char desc, footer `Refs: ADR-0051`.

## Rischi noti
- `toEqual` nei test ADR-0050 esistenti con nuovo campo `tertiaryRescued?: number` — se vitest fallisce per key undefined, tornare a `toMatchObject` nei soli test nuovi (i vecchi non si toccano se passano).
- Fixture Config: ~10-14 file da aggiornare; una chiave dimenticata = typecheck rosso immediato (grep `RDAP_CONSENSUS_ENABLED` per trovare TUTTI i literal).
- `composition-root.test.ts` potrebbe costruire Config via `loadConfig()` con env — in quel caso nessun edit necessario; verificare.