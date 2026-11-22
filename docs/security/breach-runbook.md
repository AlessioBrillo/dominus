# Personal data breach runbook (GDPR arts. 33-34)

**Status: operator procedure.** The published Privacy Notice promises that a
breach likely to result in a risk to rights and freedoms is notified to the
supervisory authority within 72 hours. This is how that promise is kept.

## 0. Contain

Do not wait for a complete assessment before containing the incident. Disable
the affected credential, rotate the key, block the route or stop the job. Record
what you did and when: containment actions are part of the notification.

## 1. Assess within 24 hours

| Question | Why it matters |
|---|---|
| What data was involved? | determines whether personal data is involved at all |
| How many people and tenants? | determines the risk and the notification threshold |
| Was it confidentiality, integrity or availability? | determines the likely harm |
| Is the data still exposed? | determines whether containment worked |
| Can the effects be reversed? | determines the measures to tell people about |

A breach that is unlikely to result in a risk does not need to be notified, but
it must still be recorded here with the reasoning.

## 2. Notify the authority within 72 hours

Notify the supervisory authority named in the Privacy Notice. If the identity
of the affected people or the full scope is not yet known, notify in phases:
the law allows that, and a late complete notification is worse than a timely
partial one. Include the nature of the breach, the categories and approximate
numbers, the likely consequences and the measures taken or proposed.

## 3. Notify the people when the risk is high

Tell affected people without undue delay when the breach is likely to result in
a high risk to their rights and freedoms. Use the contact channel they already
have with the service. State what happened, what data was involved, what is
being done and what they can do. Do not include information that would help an
attacker.

## 4. Record

Keep a breach register with: the date and time of discovery, the facts, the
effects, the remediation, the authority notification (with the receipt) and the
communication to the people. The register is the evidence that the 72-hour
clock was met.

| Date | Incident | Authority notified | People notified | Closed |
|---|---|---|---|---|
| | | | | |

## 5. After

Fix the cause, add a regression test where the defect was in code, and review
whether the published security measures or the Privacy Notice need updating. A
breach that reveals a false statement in either is a second problem.
