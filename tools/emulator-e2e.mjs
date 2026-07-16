#!/usr/bin/env node
// End-to-end integration test against the Firebase Emulator Suite.
// Drives the real Cloud Functions over the callable HTTPS protocol with genuine
// anonymous auth tokens, then plays a full deterministic loop:
//   createRoom -> join -> start -> (answer correctly, resolve, advance) x11 -> finale -> accuse -> win
//
// It also verifies GUARDRAIL #1 directly: with a normal player's token it attempts
// to read the SECRET tier and another player's PRIVATE doc, and asserts both are
// denied by the security rules — while the public room doc and the player's own
// private doc are readable.
//
// Requires the emulator running:  npm run emulator   (in another terminal)
// Then:                           npm run e2e
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT = "grave-consequences";
const REGION = "us-central1";
const FN = `http://127.0.0.1:5001/${PROJECT}/${REGION}`;
const AUTH = `http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo`;
const FS = `http://127.0.0.1:8085/v1/projects/${PROJECT}/databases/(default)/documents`;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const trivia = JSON.parse(readFileSync(join(root, "content/trivia/general-knowledge-vol-1.json"), "utf8"));
const answerKey = Object.fromEntries(trivia.questions.map((q) => [q.id, q.answerIndex]));

let passed = 0;
const ok = (cond, msg) => { if (!cond) throw new Error("FAIL: " + msg); console.log("  ✓ " + msg); passed++; };

async function anonToken() {
  const r = await fetch(AUTH, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ returnSecureToken: true }) });
  const j = await r.json();
  if (!j.idToken) throw new Error("auth emulator signup failed: " + JSON.stringify(j));
  return { token: j.idToken, uid: j.localId };
}

async function callFn(name, token, data) {
  const r = await fetch(`${FN}/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ data }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${name} error: ${j.error.message || JSON.stringify(j.error)}`);
  return j.result;
}

// Raw Firestore REST read AS A CLIENT (token attached) — rules are enforced.
async function clientRead(path, token) {
  const r = await fetch(`${FS}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

function decodeField(v) {
  if (v == null) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("booleanValue" in v) return v.booleanValue;
  if ("mapValue" in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, decodeField(x)]));
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(decodeField);
  if ("nullValue" in v) return null;
  return v;
}

async function readRoom(roomId, token) {
  const { body } = await clientRead(`rooms/${roomId}`, token);
  return Object.fromEntries(Object.entries(body.fields || {}).map(([k, v]) => [k, decodeField(v)]));
}

async function main() {
  console.log("\nGrave Consequences — emulator E2E\n");

  const host = await anonToken();
  const alice = await anonToken();
  const bob = await anonToken();

  // --- create + join ---
  const { roomId, code } = await callFn("createRoom", host.token, { strikeEvery: 0 }); // disable strikes → deterministic
  ok(/^[A-Z]{4}$/.test(code), `createRoom returns a 4-letter code (${code})`);

  await callFn("joinRoom", alice.token, { code, name: "Alice", avatar: "🕵️" });
  await callFn("joinRoom", bob.token, { code, name: "Bob", avatar: "🎩" });
  let room = await readRoom(roomId, alice.token);
  ok(Object.keys(room.roster).length === 2, "two sleuths in the public roster");

  // --- GUARDRAIL #1: the secret tier is unreadable from a client ---
  const secret = await clientRead(`rooms/${roomId}/secret/state`, alice.token);
  ok(secret.status === 403, `client READ of secret tier is DENIED (status ${secret.status})`);
  const othersPrivate = await clientRead(`rooms/${roomId}/players/${bob.uid}`, alice.token);
  ok(othersPrivate.status === 403, `client READ of another player's private doc is DENIED (status ${othersPrivate.status})`);
  const ownPrivate = await clientRead(`rooms/${roomId}/players/${alice.uid}`, alice.token);
  ok(ownPrivate.status === 200, "client READ of OWN private doc is ALLOWED");
  const publicRoom = await clientRead(`rooms/${roomId}`, alice.token);
  ok(publicRoom.status === 200, "client READ of the public room doc is ALLOWED");
  // And prove no answer key / solution leaked into the public doc:
  const publicBlob = JSON.stringify(publicRoom.body);
  ok(!publicBlob.includes("answerIndex") && !/"solution"/.test(publicBlob), "public room doc leaks no answer key or solution");

  // --- start + play until solvable (answer correctly every round) ---
  await callFn("startGame", host.token, { roomId });
  let rounds = 0;
  while (rounds < 30) {
    room = await readRoom(roomId, alice.token);
    if (room.phase === "finale") break;
    if (room.phase === "trivia") {
      const qid = room.question.id;
      const correct = answerKey[qid];
      await callFn("submitAnswer", alice.token, { roomId, questionId: qid, choiceIndex: correct });
      await callFn("submitAnswer", bob.token, { roomId, questionId: qid, choiceIndex: correct });
      const res = await callFn("resolveRound", host.token, { roomId });
      ok(res.wrong === 0, `round ${room.round}: both correct, nobody culled`);
    } else if (room.phase === "interstitial") {
      await callFn("nextRound", host.token, { roomId });
    }
    rounds++;
  }

  room = await readRoom(roomId, alice.token);
  ok(room.phase === "finale", "the case became solvable and the finale opened");
  ok(room.solvable === true, "public board narrowed to exactly one per category");
  const clearedCount = ["suspect", "weapon", "room"].reduce((n, c) => n + (room.cleared[c]?.length || 0), 0);
  ok(clearedCount === 11, `all 11 public eliminations landed on the corkboard (${clearedCount})`);
  ok((room.reveals || []).length === 11, "11 evidence notes pinned to the board");

  // --- a wrong accusation is punished; a correct one wins ---
  const wrong = await callFn("makeAccusation", bob.token, { roomId, suspect: "grimsby", weapon: "arsenic", room: "conservatory" });
  ok(wrong.correct === false && wrong.killerProximity === 1, "a wrong accusation advances the Killer");

  const win = await callFn("makeAccusation", alice.token, { roomId, suspect: "marsh", weapon: "arsenic", room: "conservatory" });
  ok(win.correct === true && win.winner === true, "the correct accusation (Marsh / arsenic / conservatory) wins");

  room = await readRoom(roomId, alice.token);
  ok(room.phase === "game_over" && room.finale.winner.name === "Alice", "game ends with Alice as the winner");
  ok(room.finale.solution?.suspect === "marsh", "the solution is revealed only now, at game over");

  console.log(`\nPASS — ${passed} assertions green. Full loop + tier isolation verified.\n`);
}

main().catch((e) => { console.error("\n" + e.message + "\n"); process.exit(1); });
