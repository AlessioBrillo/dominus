# Implementation Plan: Preflight Skill per DOMINUS

## Overview

Il skill `/preflight` funge da **quality gate locale** per DOMINUS. Si esegue prima di ogni `git push` per intercettare errori di tipo, lint, test, violazioni di sicurezza e architettura.

## Architecture

```
Invoke /preflight
  ├── Dynamic Context Injection (git status, git diff)
  ├── Classify Changed Areas (src/ or frontend/)
  ├── Run Checks (typecheck, lint, test)
  └── Diff Audit (security, quality, arch, tests)
      └── Structured Report + Verdict
```

## Edge case gestiti

- **Diff grandi** (> 200 righe): non leggere il raw diff, usare Read/Grep mirati
- **Toolchain mancante**: se npm non è installato, segnala `⚠️ degraded` e procedi con diff audit
- **Solo documentazione**: salta Step 2, vai diretto al diff audit
- **Nessuna modifica**: report "Nothing to check" e esci
