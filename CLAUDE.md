# Grave Consequences — Claude Code handoff

You're picking up a party murder-mystery game. This file is your operating brief.
The full design is in `docs/DESIGN_SPEC.md` — treat it as the source of truth and
read it before writing platform code.

## What the game is (3 lines)
One shared screen (a TV) plus everyone on their phones. Players answer trivia to
earn evidence that eliminates suspects/weapons/rooms Clue-style; wrong answers send
them to a deadly minigame; the dead keep playing as ghosts; the game ends in a
race to accuse the killer while the killer chases. It's Jackbox's Trivia Murder
Party fused with Clue.

## Current state
**Built (and verified):**
- Design spec — `docs/DESIGN_SPEC.md`.
- One mystery — `content/cases/ravenwood-manor.json`.
- One question pack — `content/trivia/general-knowledge-vol-1.json`.
- The content validator — `tools/validate.mjs` (`npm run validate`).
- Pure engine core — `src/engine/contentLoader.mjs` (tier split, grading,
  dispensing) and `src/engine/phases.mjs` (room phase machine). Framework-agnostic,
  no Firestore yet. `npm run demo` shows the tier split working.

**Now built (v1 vertical slice — verified end-to-end on the emulator):**
- Unit tests for the pure core — `test/engine.test.mjs` (`npm test`).
- Firestore security rules encoding the three tiers — `firestore.rules`.
- Cloud Functions (the secret tier) — `functions/index.mjs`: `createRoom`, `joinRoom`,
  `startGame`, `submitAnswer`, `resolveRound`, `drinkChalice`, `nextRound`,
  `makeAccusation`. Engine + content are synced into `functions/` by `sync-engine.mjs`.
- Host corkboard view — `web/host/` (manor map, pinned notes, red string, cleared stamps).
- Player view — `web/player/` (answer input, private leads, bounded accusation builder).
- Killing Floor (Poisoned Chalice), Killer-Strike event, and the Accusation finale.
- Emulator E2E — `tools/emulator-e2e.mjs` (`npm run e2e`): plays a full loop AND asserts
  a client is DENIED reads of the secret tier + other players' private docs (guardrail #1).

**Deferred to v2+ (per spec §7):** AI pack generator, more minigames/cases, traitor
mode, cosmetics, and a real Blaze deploy (config lives in `web/shared/config.js` +
`.firebaserc`; the code is deploy-ready via `firebase deploy`).

## Run
```bash
npm run validate   # closed-world contract on every CasePack — must pass before shipping any pack
npm run demo       # loads content, prints the public/secret split
```
Node 20+, no dependencies.

## The four non-negotiables
These are correctness and integrity constraints, not preferences. Do not violate
them to save effort.

1. **The secret tier never reaches a client.** The sealed solution, the full clue
   graph, and the trivia answer keys live ONLY in Cloud Functions. Grade answers
   server-side; send the phone only what it's earned. If a value would let a player
   cheat by reading it (DOM, network tab, Firestore listener), it belongs in
   `secret`. `src/engine/contentLoader.mjs` is server-only — never bundle it into a
   client. This is the whole game's integrity; it is also the exact hole-cards
   pattern from the Hold'em project.
2. **Own the content — no runtime model/API calls in the live game.** CasePacks and
   TriviaPacks are owned static data. Any AI generation happens offline as a
   build-time job, never during a session. (The "landlord trap": don't rent your
   core loop from a provider.)
3. **The closed-world contract holds on every CasePack.** Fixed candidate lists, one
   truth per category, clue effects are ID-sets over the board (never free text),
   and the public clues must narrow to exactly one solution. Run `npm run validate`
   before shipping ANY pack — never ship an unvalidated one. Wire it into a
   pre-commit hook or CI.
4. **Content is data; the engine is generic.** Never hardcode Ravenwood specifics
   into engine or UI. Everything case-specific comes from the loaded pack, so the
   same code plays every mystery and every trivia pack.

## Architecture at a glance
| Layer | Tech | Holds |
|---|---|---|
| Host view + player view | GitHub Pages (static) | Public + that player's private state |
| Realtime room state | Firestore | Public room doc + per-player private docs |
| Authoritative logic | Cloud Functions | The secret tier; grading; dispensing; RNG |

The three visibility tiers map to three security postures (see spec §4):
- **Public** → `rooms/{roomId}` — readable by anyone in the lobby.
- **Private** → `rooms/{roomId}/players/{uid}` — rules restrict read to that uid.
- **Secret** → no client read at all; only Functions touch the solution/graph.

## Content contracts (see spec §5 for the full rules)
- **CasePack** — `board` (victim, suspects, weapons, rooms), `solution` (secret),
  `clues[]` (each with a `tier` and an `effect`: `eliminate` | `narrow` | `confirm`
  over board IDs), `clueDispensing` (public queue on correct-answer, private queue on
  floor-survival), `killingFloor`, `finale`, `validation`.
- **TriviaPack** — `{ name, category, questions[] }`, zero story references. The
  engine binds generically: a correct answer dispenses the next case clue regardless
  of which question it was. Enabled pool must be ≥ the case's public-clue count.

## Build tasks (ordered — this is spec §11 #5–6, expanded)
1. **Integrate the pure core.** Keep `phases.mjs` and `contentLoader.mjs` as the
   logic layer; add a small unit test around `transition()` and the loader's tier
   split so the guarantees are pinned before wiring Firestore.
2. **Firestore data model + security rules.** `rooms/{roomId}` (public);
   `rooms/{roomId}/players/{uid}` (private, read-restricted to uid); secret case
   state held in Functions (memory or a Functions-only collection with no client
   read rule). Write the rules first and test them — this is guardrail #1.
3. **Cloud Functions:** `createRoom` (load content, split tiers, seed public doc),
   `submitAnswer` (grade server-side via `isCorrect`, dispense a public clue via
   `dispensePublicClue`, apply the effect to the public board), `resolveKillingFloor`
   (server RNG for the Poisoned Chalice, dispense a private lead to survivors),
   `checkAccusation`.
4. **Host view (the corkboard).** Retain the Clue-style manor map (rooms as regions)
   as the centerpiece; suspect cards along the top, weapons along the bottom; notes
   push-pin on with red string; cards get a "cleared" stamp as eliminations land.
   Subscribes to the public room doc. Aesthetic: Victorian gaslit whodunit (spec §8).
5. **Player view.** Answer input; earned private leads; the accusation builder (1 of
   N suspects / weapons / rooms — bounded choice). Subscribes to the player's own
   private doc only.
6. **Killing Floor + Killer Strikes + finale chase.** The Poisoned Chalice minigame,
   the periodic all-in strike event, and the run-from-the-killer accusation showdown.

## Working style
The owner runs a belay-style workflow: produce at full capacity, but he holds a
non-delegable quality floor. In practice for this repo — infra/skeleton before
content/models; a working skeleton before polish; and a validated detector
(`npm run validate`, plus tests) gating anything before it ships. When you finish a
unit, say what you'd check to be sure it's right, not just that it's done. Flag
clearly when a step moves from planning into committing real time.

## Conventions
ESM (`.mjs`), Node 20+. No secrets in the repo (service-account keys are gitignored;
use env/secret manager). Firebase **Blaze** plan is required for Cloud Functions.
Keep engine logic pure and platform-free; keep Firebase at the edges.

## Definition of done — v1 vertical slice
One full loop, high fidelity: lobby (with trivia-pack selection) → one trivia round →
one Killing-Floor minigame → evidence on the corkboard → the Accusation finale, using
the Ravenwood case + the General Knowledge pack, with the secret tier provably
unreachable from any client.
