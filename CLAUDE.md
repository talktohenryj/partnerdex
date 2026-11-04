# PartnerDex — fork notes

This repository is a fork of `AdityaMalani/partnerdex`. This file exists only in
the fork. It is not upstream, and it must not reach an upstream pull request.

## Branching rule for upstream pull requests

Start every branch intended for an upstream pull request from `upstream/main`,
never from this fork's `main`.

```bash
git fetch upstream main
git checkout -b <branch> upstream/main
```

This fork's `main` carries work that is not upstream yet (the contacts store,
this file). Branching from it puts that work into the pull request diff.

Branch from this fork's `main` only for work that stays in the fork.

## Keep `main` in step with upstream

This fork's `main` is the deployed code and the home of `roadmap/`. It must
not fall behind upstream. Before you start fork work, merge upstream into it:

```bash
git fetch upstream main
git checkout main && git merge upstream/main
```

Merge, do not rebase: `main` is shared and deployed. Upstream never touches
`roadmap/` or this file, so those never conflict. If the merge brings a new
upstream migration, read "Migration numbering" before you deploy.

## Migration numbering

Upstream `main` carries the `user_version` runner (upstream PR #4) with
migrations 1 to 3: the BigQuery fixups, the `install_intervals.started_by`
column, and the undated trial conversion ids. Contacts are migration 4, on
this fork's `main` and on `contacts-upstream` (upstream PR #14). They are not
upstream yet.

Email S1 (audiences) is migration 5, built on this fork's `main`. Planned
numbers: Email S2 (identify + custom attributes) = 6, Email S3 (compose + send)
= 7, Email S5 (app messages) = 8, Usage Metrics S1 = 9, Usage Metrics S3 = 10.

Each migration number belongs to one migration. If two branches both add "the
next" number, a database already at that version skips the second one with no
error. `test/migrate.test.ts` fails when `MIGRATIONS` is not exactly 1, 2, 3, …
in order. Do not weaken that test to get past a collision. Renumber instead.

Before you add a migration, check upstream `main` for new migrations.
Agree the number with Aditya when the contacts pull request is still open.

A database that already ran a migration under a number that later changes
needs a manual `PRAGMA user_version` fix before the renumbered code deploys.
Every migration body is idempotent, so a lower version replays safely. Snapshot
the Fly volume first. This happened on 2026-11-03: the Fly database ran
contacts as 3, so it was set to `user_version = 2` before the deploy that
brought upstream's 3 and contacts as 4.

## Response language — ASD-STE100 Simplified Technical English

Write every chat response to Henry in ASD-STE100 Simplified Technical English.
This does not change file content — code, comments, commit messages, and pull
request bodies keep the repository's own style.

Rules:

- Write short sentences. Procedural sentences: 20 words maximum. Descriptive
  sentences: 25 words maximum.
- Write one instruction in one sentence.
- Use the active voice. Do not use the passive voice.
- Use simple tenses: simple present, simple past, simple future. Do not use
  perfect tenses ("have done") or continuous tenses ("is doing").
- Use one word for one meaning. Do not use two different words for the same
  meaning.
- Keep the articles "a" and "the". Do not remove them.
- Write a maximum of 6 sentences in a paragraph.
- Do not write a noun cluster of more than 3 words.
- Put a warning or a caution before the step that it applies to.
- Use numbered steps for procedures. Use lists for sets of facts.
- Keep technical names and technical verbs. Examples: rebase, commit, migration,
  pragma, column, branch. These are correct in STE.

Do not use idioms, slang, metaphors, or wordplay.

The approved word list is not in this repository. If you are not sure that a
word is approved, use the simplest common word that gives the meaning. Say so
once if a whole response had to guess.
