## Summary

- <what changed and why — 2-3 bullet points>

## Related

- Closes: #<issue-number> (if applicable)
- Refs: ADR-NNNN (if applicable)

## Checklist

- [ ] `npm run ci:backend` passes (typecheck, build, lint, format, test)
- [ ] `npm run ci:frontend` passes (typecheck, lint, test, build)
- [ ] Architecture principles satisfied (provider abstraction, trademark gate, scoring conservatism)
- [ ] Security checklist verified (no secrets, no injection vectors)
- [ ] Provider resilience tested (multi-RDAP failover, circuit breaker, health history)
- [ ] Tests added or updated for the change
- [ ] Documentation updated (ADR, README, .env.example if new config)
- [ ] Branch is rebased on latest master
