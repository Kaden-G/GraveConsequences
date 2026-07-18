// Pins the pure engine guarantees before any Firestore wiring (CLAUDE.md build task #1).
// Zero-dependency: uses Node's built-in test runner (`node --test`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { Phase, Event, transition } from "../src/engine/phases.mjs";
import {
  loadContent,
  isCorrect,
  dispensePublicClue,
  dispensePrivateClue,
  applyEffect,
  isCaseSolvable,
  checkAccusation,
} from "../src/engine/contentLoader.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const load = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));
const casePack = () => load("content/cases/ravenwood-manor.json");
const triviaPack = () => load("content/trivia/general-knowledge-vol-1.json");

// ---- phase machine ---------------------------------------------------------

test("lobby opens the briefing, which leads into the first trivia round", () => {
  assert.equal(transition(Phase.LOBBY, Event.START), Phase.BRIEFING);
  assert.equal(transition(Phase.BRIEFING, Event.RESOLVE_DONE), Phase.TRIVIA);
});

test("a closed round goes to the reveal beat first", () => {
  assert.equal(transition(Phase.TRIVIA, Event.ANSWERS_IN), Phase.REVEAL);
});

test("an all-correct reveal advances to the interstitial, not the killing floor", () => {
  const next = transition(Phase.REVEAL, Event.RESOLVE_DONE, { someoneWrong: () => false });
  assert.equal(next, Phase.INTERSTITIAL);
});

test("a reveal with a wrong answer routes to the killing floor", () => {
  const next = transition(Phase.REVEAL, Event.RESOLVE_DONE, { someoneWrong: () => true });
  assert.equal(next, Phase.KILLING_FLOOR);
});

test("the killer strikes drags trivia straight to the killing floor", () => {
  assert.equal(transition(Phase.TRIVIA, Event.KILLER_STRIKES), Phase.KILLING_FLOOR);
});

test("interstitial opens the finale only once the case is solvable", () => {
  assert.equal(
    transition(Phase.INTERSTITIAL, Event.RESOLVE_DONE, { caseSolvable: () => false }),
    Phase.TRIVIA
  );
  assert.equal(
    transition(Phase.INTERSTITIAL, Event.RESOLVE_DONE, { caseSolvable: () => true }),
    Phase.FINALE
  );
});

test("a correct accusation ends the game; a wrong one holds the finale", () => {
  assert.equal(
    transition(Phase.FINALE, Event.ACCUSATION, { accusationCorrect: () => true }),
    Phase.GAME_OVER
  );
  assert.equal(
    transition(Phase.FINALE, Event.ACCUSATION, { accusationCorrect: () => false }),
    Phase.FINALE
  );
});

test("events that don't apply to a phase are no-ops", () => {
  assert.equal(transition(Phase.LOBBY, Event.ACCUSATION), Phase.LOBBY);
  assert.equal(transition(Phase.GAME_OVER, Event.START), Phase.GAME_OVER);
});

// ---- tier split (guardrail #1: secret never reaches a client) --------------

test("loadContent keeps solution, clue effects, and answer keys out of public", () => {
  const { publicState, secret } = loadContent(casePack(), [triviaPack()]);

  // The public state must not carry any solution-bearing field.
  const publicBlob = JSON.stringify(publicState);
  assert.equal(publicBlob.includes("answerIndex"), false, "answer keys leaked to public");
  assert.equal(publicBlob.includes("\"solution\""), false, "solution leaked to public");
  assert.equal(/"effect"/.test(publicBlob), false, "clue effects leaked to public");

  // Public trivia carries prompt + options only.
  for (const q of publicState.triviaPublic) {
    assert.deepEqual(Object.keys(q).sort(), ["id", "options", "prompt"]);
  }

  // The secret half actually holds the hidden material.
  assert.equal(secret.solution.suspect, "marsh");
  assert.equal(Object.keys(secret.triviaAnswers).length, publicState.triviaPublic.length);
  assert.ok(Object.keys(secret.clues).length >= 11);
});

test("grading is server-side and correct", () => {
  const { secret } = loadContent(casePack(), [triviaPack()]);
  // gk_planet's answer is Jupiter at index 0.
  assert.equal(isCorrect(secret, "gk_planet", 0), true);
  assert.equal(isCorrect(secret, "gk_planet", 1), false);
});

// ---- dispensing + solvability (the full narrowing to one answer) -----------

test("public clues dispense in authored order and narrow to exactly the solution", () => {
  const { publicState, secret } = loadContent(casePack(), [triviaPack()]);
  assert.equal(isCaseSolvable(publicState), false);

  let clue;
  let dispensed = 0;
  while ((clue = dispensePublicClue(secret)) !== null) {
    applyEffect(publicState, clue.effect);
    dispensed++;
  }

  // 21 public eliminations authored (5 suspects + 3 weapons + 13 rooms).
  assert.equal(dispensed, 21);
  assert.equal(isCaseSolvable(publicState), true);

  // The single survivor in each category is the sealed solution.
  const survivor = (list, cleared) => list.filter((c) => !cleared.includes(c.id));
  assert.deepEqual(survivor(publicState.board.suspects, publicState.cleared.suspect).map((c) => c.id), ["marsh"]);
  assert.deepEqual(survivor(publicState.board.weapons, publicState.cleared.weapon).map((c) => c.id), ["arsenic"]);
  assert.deepEqual(survivor(publicState.board.rooms, publicState.cleared.room).map((c) => c.id), ["conservatory"]);
});

test("private leads dispense from their own queue and never touch the public board", () => {
  const { publicState, secret } = loadContent(casePack(), [triviaPack()]);
  const before = JSON.stringify(publicState.cleared);

  const lead = dispensePrivateClue(secret);
  assert.ok(lead && lead.content, "expected a private lead");
  // A private confirm/lead must not be applied to the shared cleared lists.
  assert.equal(JSON.stringify(publicState.cleared), before);
});

test("checkAccusation validates against the sealed solution only", () => {
  const { secret } = loadContent(casePack(), [triviaPack()]);
  assert.equal(checkAccusation(secret, { suspect: "marsh", weapon: "arsenic", room: "conservatory" }), true);
  assert.equal(checkAccusation(secret, { suspect: "grimsby", weapon: "arsenic", room: "conservatory" }), false);
});
