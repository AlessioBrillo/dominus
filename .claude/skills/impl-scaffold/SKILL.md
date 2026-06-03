---
name: impl-scaffold
description: >
  Scaffold a new production-grade module within the DOMINUS personal domain investment tool.
  Automatically maps module types to their directory structure, creates boilerplate code,
  TypeScript interfaces, unit test skeletons, and SQLite migration stubs.
  Supports: core, provider, scoring, trademark, portfolio, db, cli, and frontend layers.
disable-model-invocation: true
context: fork
agent: general-purpose
arguments: [module-type, module-name]
allowed-tools: Bash(*) Read Write
---

# DOMINUS Module Scaffolding

Scaffold a new module of type `$module-type` with the name `$module-name`.

---

## 1. Preconditions & Module Map

1. **Module Type Validation**: Verify `$module-type` is one of:
   - `provider` — External data provider adapter (Whois, RDAP, Comps, Trademark, Keyword)
   - `scoring` — Scoring engine signal/component
   - `pipeline` — Pipeline stage or orchestrator component
   - `trademark` — Trademark gate component
   - `portfolio` — Portfolio management component
   - `db` — Database migration, repository, or schema
   - `cli` — CLI command or handler
   - `frontend` — React/Vite dashboard component

   If not, return an error listing valid module types.

2. **Name Validation**: Verify `$module-name` matches `^[a-z][a-z0-9-]{1,48}[a-z0-9]$` (kebab-case, 3-50 chars). If not, return an error.

3. **Target Directory Mapping**:

| Module Type | Directory | Entry point | Language |
|-------------|-----------|-------------|----------|
| `provider` | `src/providers/$module-name/` | `index.ts` | TypeScript |
| `scoring` | `src/scoring/$module-name/` | `index.ts` | TypeScript |
| `pipeline` | `src/pipeline/$module-name/` | `index.ts` | TypeScript |
| `trademark` | `src/trademark/$module-name/` | `index.ts` | TypeScript |
| `portfolio` | `src/portfolio/$module-name/` | `index.ts` | TypeScript |
| `db` | `src/db/` | `index.ts` | TypeScript + SQL |
| `cli` | `src/cli/$module-name/` | `index.ts` | TypeScript |
| `frontend` | `frontend/src/modules/$module-name/` | `index.ts` | TypeScript/React |

---

## 2. Common Scaffolding Rules

### Directory Structure (all TypeScript modules)
```
src/<module-type>/<module-name>/
├── index.ts          # Barrel export
├── types.ts          # TypeScript interfaces and types
├── <service>.ts      # Core logic (name derived from module-name)
└── __tests__/
    └── <service>.test.ts  # Unit test with Vitest
```

### File: `index.ts`
```typescript
export * from './types';
export { ClassName } from './<service>';
```

### File: `types.ts`
```typescript
export interface ModuleConfig {
  // TODO: define configuration for this module
  enabled?: boolean;
}

// TODO: add domain-specific types here
```

### File: `<service>.ts`
Use PascalCase transformation of `$module-name` for the class name:
- `whois-provider` → `WhoisProvider`
- `domain-scorer` → `DomainScorer`
- `tm-checker` → `TmChecker`

```typescript
import { ModuleConfig } from './types';

export class ClassName {
  readonly #config: ModuleConfig;

  constructor(config: ModuleConfig = {}) {
    this.#config = config;
  }

  // TODO: implement core logic
}
```

### File: `__tests__/<service>.test.ts`
```typescript
import { describe, it, expect } from 'vitest';
import { ClassName } from '../<service>';

describe('ClassName', () => {
  it('creates an instance with default config', () => {
    const instance = new ClassName();
    expect(instance).toBeInstanceOf(ClassName);
  });
});
```

---

## 3. Provider Module Scaffolding (`provider`)

Creates a provider adapter following the provider-agnostic abstraction principle.

### Also generates: interface definition
```
src/providers/<module-name>/
├── index.ts
├── types.ts
├── <module-name>-provider.ts     # Interface
├── <module-name>-provider-impl.ts # Free/public implementation
└── __tests__/
    └── <module-name>-provider.test.ts
```

### File: `<module-name>-provider.ts` (interface)
```typescript
export interface ProviderConfig {
  baseUrl?: string;
  timeoutMs?: number;
}

export interface ProviderResult<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

export interface ModuleNameProvider {
  readonly name: string;
  configure(config: ProviderConfig): void;
  lookup(query: string): Promise<ProviderResult<unknown>>;
}
```

### File: `<module-name>-provider-impl.ts` (free implementation)
```typescript
import { ModuleNameProvider, ProviderConfig, ProviderResult } from './<module-name>-provider';

export class ModuleNameProviderImpl implements ModuleNameProvider {
  readonly name = '<module-name>';
  #config: ProviderConfig = { timeoutMs: 10000 };

  configure(config: ProviderConfig): void {
    this.#config = { ...this.#config, ...config };
  }

  async lookup(query: string): Promise<ProviderResult<unknown>> {
    // TODO: implement free/public API call
    return { success: false, error: { code: 'NOT_IMPLEMENTED', message: 'Provider stub' } };
  }
}
```

---

## 4. Scoring Module Scaffolding (`scoring`)

Creates a scoring signal or component for the heuristic engine.

### Also generates: weight configuration
```
src/scoring/<module-name>/
├── index.ts
├── types.ts
├── <module-name>-signal.ts       # Signal evaluator
├── <module-name>-weights.ts      # Tunable weight configuration
└── __tests__/
    └── <module-name>-signal.test.ts
```

### File: `<module-name>-signal.ts`
```typescript
import { ModuleNameWeights, DEFAULT_WEIGHTS } from './<module-name>-weights';

export interface SignalInput {
  domain: string;
  tld: string;
  length: number;
  // TODO: add signal-specific input fields
}

export interface SignalOutput {
  score: number;        // 0 to 1
  confidence: number;   // 0 to 1
  details: Record<string, unknown>;
}

export class ModuleNameSignal {
  readonly #weights: ModuleNameWeights;

  constructor(weights: Partial<ModuleNameWeights> = {}) {
    this.#weights = { ...DEFAULT_WEIGHTS, ...weights };
  }

  evaluate(input: SignalInput): SignalOutput {
    // TODO: implement signal logic — be conservative (Principle 5)
    return { score: 0, confidence: 0, details: {} };
  }
}
```

### File: `<module-name>-weights.ts`
```typescript
export interface ModuleNameWeights {
  readonly enabled: boolean;
  readonly weight: number;   // contribution to final score (0 to 1)
  readonly threshold: number; // minimum score to contribute
}

export const DEFAULT_WEIGHTS: ModuleNameWeights = {
  enabled: true,
  weight: 0.5,
  threshold: 0.1,
};
```

---

## 5. Pipeline Stage Scaffolding (`pipeline`)

Creates a pipeline stage that fits into the 5-stage sequential flow.

```
src/pipeline/<module-name>/
├── index.ts
├── types.ts
├── <module-name>-stage.ts       # Stage implementation
└── __tests__/
    └── <module-name>-stage.test.ts
```

### File: `<module-name>-stage.ts`
```typescript
import { Stage } from '../stage';

export interface StageInput {
  candidates: string[];
  // TODO: add stage-specific input
}

export interface StageOutput {
  passed: string[];
  failed: Array<{ domain: string; reason: string }>;
  // TODO: add stage-specific output
}

export class ModuleNameStage implements Stage<StageInput, StageOutput> {
  readonly name = '<module-name>';

  async execute(input: StageInput): Promise<StageOutput> {
    // TODO: implement stage logic
    return { passed: input.candidates, failed: [] };
  }
}
```

---

## 6. Database Scaffolding (`db`)

Creates a SQLite migration file and repository class.

### Also generates: migration SQL

```
src/db/
├── index.ts
├── migrations/
│   └── NNNN_create_<table-name>.ts
└── repositories/
    └── <entity>-repository.ts
```

### Migration file: `src/db/migrations/NNNN_create_<table-name>.ts`
```typescript
import { Database } from 'better-sqlite3';

export async function up(db: Database): Promise<void> {
  db.exec(`
    CREATE TABLE IF NOT EXISTS <table_name> (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
      -- TODO: add columns
    );
  `);
}

export async function down(db: Database): Promise<void> {
  db.exec(`DROP TABLE IF EXISTS <table_name>;`);
}
```

---

## 7. CLI Command Scaffolding (`cli`)

Creates a CLI command handler using a lightweight argument parser.

```
src/cli/<module-name>/
├── index.ts
├── types.ts
├── <module-name>-command.ts
└── __tests__/
    └── <module-name>-command.test.ts
```

### File: `<module-name>-command.ts`
```typescript
export interface CommandOptions {
  // TODO: define CLI flags and arguments
}

export class ModuleNameCommand {
  readonly name = '<module-name>';
  readonly description = 'TODO: describe this command';

  async execute(options: CommandOptions): Promise<void> {
    // TODO: implement command logic
    console.log('Not yet implemented');
  }
}
```

---

## 8. Frontend Scaffolding (`frontend`)

Creates a React/Vite/Tailwind component with hook.

```
frontend/src/modules/<module-name>/
├── index.ts
├── types.ts
├── components/
│   └── <ComponentName>.tsx
├── hooks/
│   └── use<ComponentName>.ts
└── __tests__/
    └── <ComponentName>.test.tsx
```

(`ComponentName` is the PascalCase transformation of `$module-name`)

### File: `components/<ComponentName>.tsx`
```tsx
import { ComponentNameProps } from '../types';
import { useComponentName } from '../hooks/useComponentName';

export default function ComponentName({
  title = 'DOMINUS',
}: ComponentNameProps) {
  const { data, loading } = useComponentName();

  return (
    <div className="p-4 rounded-lg border border-slate-700 bg-slate-800/50">
      <h2 className="text-lg font-semibold text-slate-100">{title}</h2>
      {loading ? (
        <p className="text-slate-400">Loading...</p>
      ) : (
        <pre className="text-sm text-slate-300 mt-2">{JSON.stringify(data, null, 2)}</pre>
      )}
    </div>
  );
}
```

### File: `hooks/useComponentName.ts`
```typescript
import { useState, useEffect } from 'react';

export function useComponentName() {
  const [data, setData] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // TODO: fetch data from API
    setLoading(false);
  }, []);

  return { data, loading };
}
```

---

## 9. Execution Requirements

1. **Directory Creation**: Create the directory hierarchy first using `mkdir -p`.
2. **File Creation**: Write files in order using the Write tool, substituting `$module-type`, `$module-name`, `ClassName`, and `ComponentName` as needed.
3. **No Workspace Registration**: DOMINUS does not use a monorepo workspace manager. New modules are self-contained directories. No config files need updating.
4. **Validation**:
   - For TypeScript modules: no automatic compilation check needed (modules are imported by consumer code).
   - For frontend modules: ensure the component is importable from `frontend/src/App.tsx`.
5. **English Only**: All identifiers, comments, types, and documentation must be in English.

---

## 10. Quick Reference: Module Name Transformations

| kebab-case (input) | PascalCase (class/component) |
|---|---|
| `whois-provider` | `WhoisProvider` |
| `rdap-confirmer` | `RdapConfirmer` |
| `domain-scorer` | `DomainScorer` |
| `tm-checker` | `TmChecker` |
| `renewal-clock` | `RenewalClock` |
| `candidate-generator` | `CandidateGenerator` |
| `keyword-signal` | `KeywordSignal` |
| `drop-verdict` | `DropVerdict` |
| `portfolio-table` | `PortfolioTable` |
| `closeout-importer` | `CloseoutImporter` |
