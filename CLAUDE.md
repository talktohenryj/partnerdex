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

## Migration numbering

Contacts currently ship as migration 1 in `src/db/migrate.ts`. That is not the
agreed final numbering. Per issue #2 upstream, the `user_version` runner absorbs
Aditya's ad-hoc `migrate()` column fixups from `src/db/index.ts` as migrations 1
and 2, that function is deleted, and contacts move to migration 3.

Keep every column-existence check when moving those fixups into migration
bodies. The ad-hoc function is already deployed on upstream `main`, so those
databases hold the changes while `user_version` is still 0. An unguarded
migration replays the `ALTER` and fails with `duplicate column name`.

Any database already at `user_version = 1` under the old numbering needs
`PRAGMA user_version = 0` before deploying the renumbered runner. Every
migration body is idempotent, so the replay is safe. Snapshot the Fly volume
first.

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
