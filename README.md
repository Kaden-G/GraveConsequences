# Grave Consequences

A party murder-mystery game for phones + a shared screen — **Trivia Murder Party
meets Clue**. You earn evidence by surviving a trivia gauntlet, the dead keep
investigating as ghosts, and the game ends in a run-from-the-killer accusation.

- **Design source of truth:** [`docs/DESIGN_SPEC.md`](docs/DESIGN_SPEC.md)
- **Build handoff for Claude Code:** [`CLAUDE.md`](CLAUDE.md)

## Stack
Firebase Hosting (host + player views) · Firestore (realtime room state) · Cloud
Functions (authoritative logic). Content — mysteries (`CasePack`) and questions
(`TriviaPack`) — is owned static data; the live game calls no model APIs.

## Status
**v1 vertical slice is built and verified end-to-end.** The full loop runs on the
Firebase Emulator Suite: lobby (room code + live roster) → trivia round → public
clue lands on the corkboard (cleared stamp + red string) → the Killing Floor
(Poisoned Chalice) → the Accusation finale → win/reveal. The secret tier is
provably unreachable from any client (guardrail #1) — see `tools/emulator-e2e.mjs`.

## Run
```bash
npm run validate   # closed-world contract on every CasePack (the "validated detector")
npm run demo       # load content, show the public/secret tier split
npm test           # unit tests: phase machine + tier split (node --test)

npm run emulator   # boot Firestore + Functions + Auth + Hosting locally
npm run e2e        # (in a second terminal) drive the whole loop + prove tier isolation
```
Then open the printed Hosting URL: **`/host/`** on a TV/laptop, **`/player/`** on
each phone. Node 20+. The emulator needs Java; deploying for real needs a Firebase
**Blaze** project (paste its web config into `web/shared/config.js`, set the
project id in `.firebaserc`, then `firebase deploy`).

## Layout
```
docs/        design spec
content/     cases/ (mysteries) and trivia/ (question packs)
src/engine/  pure loader + phase machine (SERVER-ONLY secrets live here)
tools/       validate.mjs, demo.mjs, emulator-e2e.mjs
test/        unit tests for the pure core
functions/   Cloud Functions — the authoritative server tier (the secret tier)
web/         host/ (the corkboard TV) + player/ (the phone) + shared/ glue
firestore.rules   the three-tier visibility model as security postures
firebase.json     hosting + functions + emulator config
```

## The three tiers (see spec §4)
- **Public** `rooms/{roomId}` — readable by any player; the board, question, roster, reveals.
- **Private** `rooms/{roomId}/players/{uid}` — readable only by that uid; your leads, your answer.
- **Secret** `rooms/{roomId}/secret/*` — no client read at all; solution, clue effects,
  answer keys, death-roll RNG. Only Cloud Functions touch it. All writes go through Functions.
