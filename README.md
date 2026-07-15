# Grave Consequences

A party murder-mystery game for phones + a shared screen — **Trivia Murder Party
meets Clue**. You earn evidence by surviving a trivia gauntlet, the dead keep
investigating as ghosts, and the game ends in a run-from-the-killer accusation.

- **Design source of truth:** [`docs/DESIGN_SPEC.md`](docs/DESIGN_SPEC.md)
- **Build handoff for Claude Code:** [`CLAUDE.md`](CLAUDE.md)

## Stack
GitHub Pages (host + player views) · Firestore (realtime room state) · Cloud
Functions (authoritative logic). Content — mysteries (`CasePack`) and questions
(`TriviaPack`) — is owned static data; the live game calls no model APIs.

## Status
Pre-alpha scaffold. Design + content contracts + validator + pure engine core are
in place; Firestore wiring, Cloud Functions, security rules, and the UIs are the
next build.

## Run
```bash
npm run validate   # enforce the closed-world contract on every CasePack
npm run demo       # load content and show the public/secret tier split
```
No dependencies — Node 20+ only.

## Layout
```
docs/      design spec
content/   cases/ (mysteries) and trivia/ (question packs)
src/       engine/ — pure loader + phase machine (SERVER-ONLY secrets live here)
tools/     validate.mjs (the "validated detector"), demo.mjs
```
