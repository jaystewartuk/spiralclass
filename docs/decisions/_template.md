# D-NN. Short declarative title — the decision, not the topic

<!--
  Before copying this, check the bar (D-202). A record is warranted only when
  ALL THREE hold:

    1. there were at least two real options;
    2. a wrong choice is expensive or hard to undo; and
    3. someone could plausibly undo it later without knowing why.

  Otherwise the reasoning goes in the PR body, behaviour in docs/features/, and
  the constraint in a guard test or a comment where the rule applies.

  If a record for the topic already exists, AMEND IT rather than opening a
  successor: rewrite what is now true, and add the change to How we got here.

  Copy to the next unused number (never reuse a retired one — see the README's
  Retired numbers table), delete this comment, and add a row to both tables in
  README.md. Keep it under 1,500 words; aim for about 800.
-->

The decision, in the first sentence, specific enough that a reader can check it
against the code.

## Why

The constraint that forced it. Where a number decided it, show the number and
how it was taken — a record that says "measured" without saying how is worth no
more than a guess.

## Options considered

- **The option** — the specific thing it fails on. This is usually the most
  useful section and the one most often skipped.

## What it cost

What was knowingly given up, and what is still open. A decision with no stated
cost has not been thought about.

## What it constrains

What a future change must not do, and why — written for the person who will be
tempted to undo it without knowing what it was for. Name the guard that enforces
it, if one does.

## How we got here

Each earlier version of this decision, what went wrong with it and what that
cost, and every measured number with how it was measured. When this record is
amended, the change goes here — with what changed about the premise.
