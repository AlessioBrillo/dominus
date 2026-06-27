# Architecture Diagrams

This directory contains Mermaid-format architecture diagrams for DOMINUS.

## Index

| Diagram | File | Covers |
|---------|------|--------|
| Pipeline Architecture | [pipeline-architecture.md](pipeline-architecture.md) | 5-stage async pipeline, input sources, output verdicts |
| Provider Abstraction | [provider-abstraction.md](provider-abstraction.md) | Interface pattern, community/cloud implementations, cross-cutting decorators |
| Scoring Engine | [scoring-engine.md](scoring-engine.md) | 4-signal heuristic valuator, weight redistribution, confidence composition |
| Job Execution | [job-execution.md](job-execution.md) | Async job queue, worker lifecycle, handler dispatch, graceful shutdown |
| SaaS Architecture | [saas-architecture.md](saas-architecture.md) | DOMINUS Cloud multi-tenant deployment, RLS + PostgreSQL |
| Module Dependencies | [module-dependency.md](module-dependency.md) | High-level module graph for `src/` |
| Deployment | [deployment.md](deployment.md) | Docker build, K8s deployment, local development |

## Rendering

These diagrams use [Mermaid](https://mermaid.js.org/) syntax and render natively
in GitHub-flavoured Markdown. For local preview, use the [Mermaid CLI](https://github.com/mermaid-js/mermaid-cli):

```bash
npx @mermaid-js/mermaid-cli docs/diagrams/pipeline-architecture.md
```

Or install the [Mermaid Preview](https://marketplace.visualstudio.com/items?itemName=bierner.markdown-mermaid) VS Code extension.
