# Founding cohort and design partners

Status: **operator plan for the paid launch** (ADR-0111, ADR-0112, ADR-0113).

The price was decided without a paying customer. Before the list price is
set in stone, the product needs twenty people who have actually used a
portfolio in it and fifteen interviews about what they would pay.

## 1. Fifteen willingness-to-pay interviews

Ask investors with **50–500 domains**. Do not pitch; ask:

1. How many domains do you renew in a year, and at what cost?
2. How do you decide keep/drop today, and how long does it take?
3. What did the last bad purchase cost you?
4. Which tools do you pay for already, and what do they cost?
5. At €19 / €29 / €49 / €79 per month, where would you stop buying?
6. Would annual billing at ten months change the decision?

Record the answer to question 5, not the compliments. The founding price
stays €29; the list price after the cohort is decided from these answers.

## 2. Twenty design partners

- Invite from the waitlist, NamePros, DNForum, r/Domains and the open-source
  community.
- Pro free for 60 days on staging, with a direct support channel.
- Ask for one thing in return: a real portfolio import and a monthly
  keep/drop decision made from the dashboard.
- Ask for a testimonial only after the partner has made a decision with the
  tool, never before.

## 3. What to measure

The first-party funnel is already instrumented in the `events` table and
shown on the operator overview:

```
signup → verified → first score → portfolio import → checkout
```

Targets: signup→verified ≥70%, verified→first score ≥60%, first score→import
≥40%, free→paid 2–5%, churn <5%/month, first response <1 business day.

## 4. Founding offer

- First **50** paying customers: €29/month, locked for as long as they stay.
- Annual at €290 (ten monthly payments) for everyone.
- No percentage discount, no coupon, no countdown. The price is a founding
  price because the cohort is limited, not because the product is cheap.
- After 50 customers, the list price moves to the value supported by the
  interviews and the activation data. Existing customers are grandfathered.

## 5. Launch sequence

1. Community soft launch and waitlist (already done).
2. v1.8.0, staging apply, restore drill, real SMTP, external probe.
3. Design partners on staging, feedback, testimonials; audit and fiscal work
   in parallel (the longest lead time).
4. Founding cohort to the waitlist; then Product Hunt, Hacker News (open
   source angle), community posts and the first comparison/SEO articles.
5. Measure, fix activation, then raise the list price.
