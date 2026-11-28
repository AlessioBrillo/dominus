# Design partner outreach and willingness-to-pay interviews

Status: **operator runbook for Phase B** ([ADR-0117](../adr/0117-mobile-release-sequence.md),
[founding-cohort.md](founding-cohort.md)). This file contains the messages and the
question set the operator needs to recruit 20 design partners and run 15
willingness-to-pay interviews. It is text to send, not code: nothing here
changes the product or publishes a claim about it.

## Rules for every contact

1. **Ask, do not pitch.** The product sells a decision method, not a predicted
   price ([ADR-0115](../adr/0115-mobile-value-contract-method-not-estimate.md)).
2. **One ask only:** import a real portfolio and make one monthly keep/drop
   decision from it. A second ask halves the response rate.
3. **Never ask for a testimonial before the decision has been made.** After a
   real decision, ask for one sentence describing what changed.
4. **Record the answer to the price question, not the compliments.** Enthusiasm
   is not willingness to pay.
5. **English only**, consistent with the published legal text (ADR-0109).
6. Store names, answers and quotes in the operator's private log. The tool's
   own data rights cover workspace data, not interview notes: do not put
   interview notes into a tenant workspace.

## Targets

| Cohort | Number | Source |
|---|---|---|
| Existing waitlist | 6 | first-party waitlist on the canonical origin |
| NamePros | 4 | portfolio and closeout threads |
| DNForum | 4 | portfolio and renewal discussions |
| r/Domains | 4 | keep/drop and renewal threads |
| Open-source community | 2 | GitHub Discussion, self-hosting audience |

Total: **20 design partners**. Keep a fifth slot open per channel: replies,
not sends, are the unit that matters.

## Outreach messages

Replace `[name]`, `[domain]` and `[your-domain]` before sending. Do not add a
price, a deadline or a countdown: the founding offer is a locked price for a
limited cohort, not a discount ([founding-cohort.md](founding-cohort.md)).

### Waitlist (six variants)

1. **Subject: A portfolio decision I would like your help with**
   Hi [name] — you joined the DOMINUS list. I am looking for twenty investors
   with a real portfolio to try one specific job: decide which names to keep
   and which to drop next month. Would you use yours in the tool for that one
   decision? No card, no commitment; I want the part that does not work.

2. **Subject: Your renewal list, one decision**
   Hi [name] — before I open this to everyone, I need to see whether the
   renewal clock is actually useful. If you import your list, I will ask for
   one keep/drop verdict from you and nothing else. Interested?

3. **Subject: Twenty portfolios, one question**
   Hi [name] — the question I cannot answer from code is whether the keep/drop
   verdict saves time on a real list. You are on the waitlist; would you be
   one of twenty people I ask to try it on yours?

4. **Subject: Early access, narrow ask**
   Hi [name] — early access is open to a small group. The only condition is
   that you import a real portfolio and make one renewal decision in it. If
   that sounds useful, I will send the link.

5. **Subject: What would make you drop a domain?**
   Hi [name] — I am building the drop verdict and I would rather watch someone
   use it than guess. Would you run your next keep/drop review in DOMINUS and
   tell me where it got in your way?

6. **Subject: One month, one portfolio**
   Hi [name] — if you have a list you renew each year, I would like to watch
   how you decide what to keep. One import, one decision, then you tell me what
   was missing. Worth ten minutes of your time?

### NamePros (four variants)

7. **Subject: Does the keep/drop verdict match how you decide?**
   Hi [name] — I saw your post about renewals. I am building an open-source
   decision tool, not an appraisal service: it shows a buy ceiling, a
   trademark screening verdict and a renewal verdict with the evidence behind
   each. Would you run your list through it once and tell me where it disagrees
   with you?

8. **Subject: Real portfolios wanted, no signup fee**
   Hi [name] — I need twenty real portfolios to test one workflow: import,
   then decide keep or drop. The tool is free while I am testing and there is
   no card. If you want to try it, I will send a link.

9. **Subject: A tool that says what evidence is missing**
   Hi [name] — DOMINUS refuses to guess when a signal has no data; it tells you
   which one is missing instead. I would like to know if that is useful to
   someone who actually renews names. Would you try it on your list?

10. **Subject: Closeout decisions, one at a time**
    Hi [name] — if you buy closeouts, the buy ceiling and the trademark gate
    are the two things I want to validate. Would you score a few real
    candidates and tell me if the ceiling is too generous or too tight?

### DNForum (four variants)

11. **Subject: Your keep/drop process, one run**
    Hi [name] — I am testing a renewal clock and a keep/drop verdict against
    real portfolios. You import the list, you make one decision, you tell me if
    the verdict helped. Would you do that?

12. **Subject: Open-source portfolio tool, twenty testers**
    Hi [name] — DOMINUS is AGPL and self-hostable. Before I open it wider I
    need twenty people with real names in it. The only request is one monthly
    keep/drop decision. Interested?

13. **Subject: What did your last bad purchase cost?**
    Hi [name] — I am interviewing investors about the buy ceiling. I will not
    pitch anything: I want the number and what caused it. Do you have fifteen
    minutes this week?

14. **Subject: Trademark screening before the buy**
    Hi [name] — the tool checks public trademark sources before any buy
    recommendation and fails closed when they cannot answer. Would you run a
    few of your candidates through it and tell me if that changes your process?

### r/Domains (four variants)

15. **Subject: Testing a renewal verdict on real lists**
    Hi [name] — your comment about renewals stuck with me. I am building a tool
    that gives one keep/drop verdict per domain, with the renewal cost next to
    it. Would you try it on your list and tell me if the verdict is useful?

16. **Subject: Twenty people, one real portfolio decision**
    Hi [name] — I am looking for twenty design partners. Import a real
    portfolio, make one keep/drop decision, tell me what was missing. No card
    and no commitment. Interested?

17. **Subject: An estimate that says when it has no data**
    Hi [name] — most valuation tools print a number with no evidence. Mine
    names the missing signals and refuses to recommend an unverified domain.
    Would you try it on a few names you already own?

18. **Subject: Would this change what you renew?**
    Hi [name] — one question: if a tool told you the carry cost and a keep/drop
    verdict for each name, would it change what you renew? If you want to find
    out, I will send the link to the early version.

### Open-source community (two variants)

19. **Subject: Self-hosters with a domain portfolio**
    Hi [name] — DOMINUS is a self-hosted, AGPL decision tool for domain
    portfolios. I need twenty people to run it on a real list and make one
    keep/drop decision. Bugs and blunt feedback are more useful than praise.

20. **Subject: One workflow to break**
    Hi [name] — the workflow is: import a real portfolio, then decide keep or
    drop. If you self-host and own domains, would you try to break that
    workflow for me? I will send the link and fix what you find.

## The fifteen willingness-to-pay questions

Ask them in this order. Questions 1-6 are the binding set from
[founding-cohort.md](founding-cohort.md); 7-15 add context without pitching.

1. How many domains do you renew in a year, and at what cost?
2. How do you decide keep/drop today, and how long does it take?
3. What did the last bad purchase cost you?
4. Which tools do you pay for already, and what do they cost?
5. At €19 / €29 / €49 / €79 per month, where would you stop buying?
6. Would annual billing at ten months change the decision?
7. Which of those paid tools would you cancel first if you had to, and why?
8. Who else in your workflow would need access to the same decision?
9. Do you make the decision alone, or does someone approve it?
10. What would have to be true for you to trust a buy ceiling?
11. When a tool says "evidence missing", do you act, ignore it, or look elsewhere?
12. How often do you review the portfolio: weekly, monthly, or at renewal time?
13. What is the longest you have kept a domain you later regretted renewing?
14. If the tool saved you one bad purchase a year, what would that be worth to you?
15. What would make you cancel a subscription to this after two months?

## Recording and gate

For each interview record: cohort, portfolio size, annual renewal spend, the
answer to question 5 verbatim, the answer to question 15 verbatim, and any
quote you may later use. Do not record answers as "positive/negative": the
price point and the cancellation reason are the data.

The Phase B exit gate is in
[pwa-launch-operations.md](pwa-launch-operations.md): at least 20 design
partners with a real keep/drop decision, ≥60% verified→first score and ≥40%
first score→import. Free→paid and churn cannot be observed while
`CLOUD_PAID_ENABLED=false`; treat them as targets for the later cohort.

For the announcement copy, use the "What not to claim" table in
[soft-launch-community.md](soft-launch-community.md). The README is the source
of truth; if a message disagrees with it, the message is wrong.
