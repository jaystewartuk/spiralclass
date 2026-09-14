---
name: issue
description: File work owed as a GitHub issue on this repository — search open AND closed issues for a duplicate first, route anything that must not be public elsewhere, write it in the house shape (a sentence from the user's side, evidence, a Done when line), and file only after the user approves the draft. Use when the user asks to file, open, raise or log an issue, when an investigation turns up findings that will not be fixed in this change, or when work is noticed that belongs to a later PR. Handles several findings at once.
---

# /issue

Open work lives in this repository's Issues ([D-172](../../../docs/decisions/D-172.md)),
and there is still no queue in the tree ([D-110](../../../docs/decisions/D-110.md)).
An issue is a **closable statement of work**: it says what is wrong or missing
and what "done" looks like, so that a pull request can close it and the closing
is the only bookkeeping.

D-172 records that **nothing enforces that shape**. This skill is the checklist
that stands in for the missing check. It ends at a filed issue and its URL.

## Why it asks before filing

The repository is public. `gh issue create` publishes the text the moment it
runs — it is indexed, it is emailed to watchers, and deleting it afterwards
does not un-send it. So the draft is shown to the user and filed only on a yes,
every time, including in batch mode.

## What you do, in order

### 1. Decide it is an issue at all

Stop and say so instead of filing when it is one of these:

- **A security problem** — anything that would help someone attack the live
  service, read another tenant's data, or move money. It goes to
  [SECURITY.md](../../../SECURITY.md)'s private channel (the repository's
  private advisory flow), **never** a public issue. If you are unsure whether it
  is exploitable, treat it as though it is and ask the user.
- **Something already settled.** A decision belongs in a decision record; an
  issue is a thing that has _not_ been settled.
- **A note to self with no end state.** If you cannot write the **Done when**
  line, it is not yet work. Ask what finishing would look like.
- **Something this change is about to fix.** Fix it; don't file it.

### 2. Search for a duplicate — open and closed

Titles here are sentences, so one keyword search misses. Search **at least
three phrasings** — the symptom, the component or file, and the cause — across
every state:

```bash
gh issue list --state all --limit 30 --search "<terms>"
gh issue list --state all --limit 30 --search "<file or module name> in:body"
```

Read the body of anything plausible (`gh issue view <n>`), not just the title.
Then:

| What you found                                  | What to do                                                                                                                   |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| An **open** issue for the same work             | Don't file. Offer a comment on it with the new evidence (`gh issue comment <n>`) — shown to the user first, like a new issue |
| A **closed** issue for the same work            | It came back, or the fix never held. File a new one that links it and says which, with the evidence                          |
| A closed issue marked `wontfix`                 | Don't file. Tell the user it was declined, and why, and let them decide whether the premise has changed                      |
| An open issue that is **related**, not the same | File, and add `Related: #n` to the body                                                                                      |

Report what you searched and what you found either way — "no duplicate" is a
claim, and the searches are its evidence.

### 3. Check what is already decided

If the work would change, reverse or work around something that exists, ask the
`decision-scout` agent which `D-NN` records constrain it. Name them in the body
and say what about their premise has changed. An issue that quietly proposes
undoing a decision gets picked up by someone who finds out halfway through.

### 4. Write it in the house shape

**Title** — a full sentence naming the problem **from the user's side**, in the
present tense because it is still true. Same rule as a commit subject, and no
category prefix:

- _The Vercel failover has never deployed, because its three credentials were never provisioned_
- _A forgotten tenant filter still returns every teacher's rows instead of none_

Not `ci: vercel secrets`, not `Fix tenant filter`.

**Body**, short, in this order:

1. **What is wrong and why it matters** — who it hurts and how. Say what is
   known and what is inferred, separately; an issue is read later by someone
   who will trust it.
2. **Evidence** — `path:line`, the command and its output, a commit, a PR, a
   Sentry or PostHog link. Enough to re-find it without this conversation.
3. **Constraints** — the `D-NN` records from step 3, and `⚠️ Tier 2` if the
   fix touches a path CLAUDE.md lists as one.
4. **`Related: #n`** lines, if any.
5. **`**Done when**`** — one line a pull request can meet and a reader can
   check. If there is a legitimate "or we decide not to", say where that
   decision would be recorded.

### 5. Choose labels

Only labels that exist — run `gh label list` rather than guessing. A label that
does not exist makes `gh issue create` fail outright.

- **One type:** `bug`, `enhancement`, `documentation`, `ci`, `accessibility`.
- **A suggested priority**, which the weekly triage may change:
  - `p1` — advances the primary metric or the evidence base
  - `p2` — supports a p1
  - `p3` — hygiene

  Say in the draft why you chose it. If you cannot justify one, leave it off
  and say so; the triage will set it.

### 6. Scrub it

Before showing the draft, remove:

- **Student and teacher personal data** — names, emails, phone numbers,
  message contents. Real conversations live in a private repository and never
  leave it; describe the shape of the problem instead.
- **Secrets** — keys, tokens, connection strings, session cookies, even
  expired ones.
- **Production identifiers that aid an attack** — if you are removing a lot of
  these, go back to step 1.

### 7. Show the draft, then file

Show the title, labels and body, the duplicate searches from step 2, and the
priority reasoning. On a yes:

```bash
gh issue create --title "<title>" --body-file <scratchpad>/issue-<slug>.md --label "enhancement" --label "p2"
```

Write the body to a file in the scratchpad rather than inlining it: backticks
and `$` in a `--body` string get eaten by the shell.

Report the issue number and URL.

## Several findings at once

An investigation that turns up several things files them in one pass:

1. Draft them all.
2. Deduplicate them **against each other** before searching the tracker — two
   drafts with the same **Done when** are one issue.
3. Run step 2 for each.
4. Show every draft together and take one approval for the batch.
5. File in dependency order, so a later issue can say `Related: #n` about an
   earlier one with a real number.

## What this skill does not do

- **It never closes, edits, relabels, transfers or deletes an existing issue.**
  Closing is what a merged PR or the triage does. If something looks like it
  should be closed, say so to the user.
- **It never creates a label.** A new label is a change to
  `apps/web/tests/config/github-labels.test.ts` as well as `gh label create`,
  and that belongs in a PR.
- **It never writes the work into a file in the tree instead** — no `TODO.md`,
  no findings section at the end of a document (D-110).

## Closing the loop

An issue stays correct only if a PR closes it. When you later fix one, `/pr`
puts `Closes #n` in the PR body.
