// Grave Consequences — Cloud Functions (the authoritative server tier).
//
// This is the ONLY place the secret tier exists at runtime: the sealed solution,
// the full clue graph, the trivia answer keys, and the death-roll RNG. Everything
// here runs with the Admin SDK, so it bypasses Firestore rules; clients can only
// READ their permitted docs and must route every mutation through these callables.
//
// Guardrail #1 (CLAUDE.md): grade server-side, send the phone only what it earned.
// The engine that does the tier split is imported from ./engine — a generated copy
// of the repo-root src/engine (see sync-engine.mjs). Never edit ./engine by hand.

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { setGlobalOptions } from "firebase-functions/v2";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadContent,
  isCorrect,
  dispensePublicClue,
  dispensePrivateClue,
  applyEffect,
  isCaseSolvable,
  checkAccusation,
} from "./engine/contentLoader.mjs";
import { Phase } from "./engine/phases.mjs";

initializeApp();
setGlobalOptions({ region: "us-central1", maxInstances: 10 });
const db = getFirestore();
const here = dirname(fileURLToPath(import.meta.url));

// --- tuning knobs (v1 playtest dials) --------------------------------------
const GOBLETS = 5; // goblets offered on the Killing Floor
const FATAL_GOBLETS = 2; // how many are laced
const STRIKE_EVERY = 4; // "The Killer Strikes" drags everyone to the floor every N rounds
const ANSWER_SECONDS = 20;
const MAX_KILLER_PROXIMITY = 3; // wrong finale accusations before the Killer wins
const REVIVE_STREAK = 3; // correct-in-a-row a Ghost needs to Quicken back to life

// --- content access (bundled copy, server-only) ----------------------------
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const loadCasePack = (caseId) => readJson(join(here, "content", "cases", `${caseId}.json`));
const loadTriviaPack = (id) => readJson(join(here, "content", "trivia", `${id}.json`));

// --- helpers ----------------------------------------------------------------
function requireAuth(request) {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
  return uid;
}

function makeCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I/O to avoid confusion
  let code = "";
  for (let i = 0; i < 4; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

const roomRef = (roomId) => db.collection("rooms").doc(roomId);
const secretRef = (roomId) => roomRef(roomId).collection("secret").doc("state");
const playersCol = (roomId) => roomRef(roomId).collection("players");

async function getRoomOrThrow(roomId) {
  const snap = await roomRef(roomId).get();
  if (!snap.exists) throw new HttpsError("not-found", "No such room.");
  return snap.data();
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Reconstruct a mutable publicState view from the stored room doc, so the engine's
// applyEffect / isCaseSolvable operate on exactly what the corkboard shows.
function publicStateFromRoom(room) {
  return {
    board: room.board,
    cleared: room.cleared || { suspect: [], weapon: [], room: [] },
  };
}

// ============================================================================
// createRoom — load content, split tiers, seed the public + secret docs.
// ============================================================================
export const createRoom = onCall(async (request) => {
  const hostUid = requireAuth(request);
  const caseId = request.data?.caseId || "ravenscourt-manor";
  const triviaPackIds = request.data?.triviaPackIds?.length
    ? request.data.triviaPackIds
    : ["general-knowledge-vol-1"];

  const casePack = loadCasePack(caseId);
  const triviaPacks = triviaPackIds.map(loadTriviaPack);
  const { publicState, secret } = loadContent(casePack, triviaPacks);

  // Trivia sufficiency (mirrors the validator's contract) — fail loudly here too.
  const publicClueCount = (secret.dispensing?.public?.queue || []).length;
  if (publicState.triviaPublic.length < publicClueCount) {
    throw new HttpsError(
      "failed-precondition",
      `Trivia pool (${publicState.triviaPublic.length}) < public clues (${publicClueCount}). Enable more packs.`
    );
  }

  const code = makeCode();
  const roomId = db.collection("rooms").doc().id;

  // PUBLIC room doc — everything on this doc is safe for the shared TV + all phones.
  await roomRef(roomId).set({
    code,
    hostUid,
    createdAt: FieldValue.serverTimestamp(),
    phase: Phase.LOBBY,
    round: 0,
    caseId: publicState.caseId,
    title: publicState.title,
    victim: publicState.victim,
    board: publicState.board,
    cleared: publicState.cleared,
    roster: {},
    question: null,
    reveals: [],
    quickenings: [],
    killingFloor: null,
    finale: null,
    solvable: false,
    settings: {
      caseId,
      triviaPackIds,
      // "The Killer Strikes" cadence — a v1 playtest dial. 0 disables strikes.
      strikeEvery: Number.isInteger(request.data?.strikeEvery) ? request.data.strikeEvery : STRIKE_EVERY,
      goblets: GOBLETS,
    },
  });

  // SECRET doc — no client can read this (rules deny the whole /secret subcollection).
  const questionOrder = shuffle(publicState.triviaPublic.map((q) => q.id));
  await secretRef(roomId).set({
    solution: secret.solution,
    clues: secret.clues,
    triviaAnswers: secret.triviaAnswers,
    dispensing: secret.dispensing,
    cursors: secret.cursors,
    questionOrder,
    questionCursor: 0,
    currentQuestionId: null,
    killingFloorFatal: null,
  });

  return { roomId, code };
});

// ============================================================================
// joinRoom — add a player (public roster entry + private player doc).
// ============================================================================
export const joinRoom = onCall(async (request) => {
  const uid = requireAuth(request);
  const code = (request.data?.code || "").toUpperCase().trim();
  const name = (request.data?.name || "Sleuth").slice(0, 24);
  const avatar = request.data?.avatar || "🔍";
  if (!/^[A-Z]{4}$/.test(code)) throw new HttpsError("invalid-argument", "Room code is four letters.");

  const q = await db.collection("rooms").where("code", "==", code).limit(1).get();
  if (q.empty) throw new HttpsError("not-found", "No room with that code.");
  const roomSnap = q.docs[0];
  const room = roomSnap.data();
  const roomId = roomSnap.id;
  if (room.phase !== Phase.LOBBY) throw new HttpsError("failed-precondition", "That game has already begun.");

  const rosterEntry = { name, avatar, alive: true, isGhost: false, vitality: 0 };
  await roomRef(roomId).update({ [`roster.${uid}`]: rosterEntry });
  await playersCol(roomId).doc(uid).set({
    name,
    avatar,
    alive: true,
    isGhost: false,
    lives: 1,
    streak: 0, // correct-in-a-row; as a Ghost this drives reanimation
    vitality: 0, // pure upward standing — never goes negative
    leads: [],
    answer: null,
    canAccuse: false,
    justQuickened: false,
  });

  return { roomId };
});

// ============================================================================
// startGame — host opens the first trivia round.
// ============================================================================
export const startGame = onCall(async (request) => {
  const uid = requireAuth(request);
  const roomId = request.data?.roomId;
  const room = await getRoomOrThrow(roomId);
  if (room.hostUid !== uid) throw new HttpsError("permission-denied", "Only the host can start.");
  if (room.phase !== Phase.LOBBY) throw new HttpsError("failed-precondition", "Already started.");
  if (Object.keys(room.roster || {}).length < 1) throw new HttpsError("failed-precondition", "Need at least one sleuth.");

  await loadNextQuestion(roomId, 1);
  return { ok: true };
});

// Shared: advance the secret question cursor, publish the next question, reset answers.
async function loadNextQuestion(roomId, round) {
  const secret = (await secretRef(roomId).get()).data();

  const order = secret.questionOrder;
  const qid = order[secret.questionCursor % order.length]; // recycle if we run long
  const question = findPublicQuestion(secret, qid);

  await secretRef(roomId).update({
    questionCursor: secret.questionCursor + 1,
    currentQuestionId: qid,
  });

  // Clear every player's answer + transient Quickening flag for the new round.
  const players = await playersCol(roomId).get();
  const batch = db.batch();
  players.forEach((p) => batch.update(p.ref, { answer: null, justQuickened: false }));
  batch.update(roomRef(roomId), {
    phase: Phase.TRIVIA,
    round,
    question: { ...question, deadline: Date.now() + ANSWER_SECONDS * 1000 },
    killingFloor: null,
    quickenings: [],
  });
  await batch.commit();
}

// The public (answer-free) form of a question, taken from the secret answer map's
// keyspace but with prompt/options pulled from the bundled pack via the room.
function findPublicQuestion(secret, qid) {
  // We stored only answers in secret; re-read prompt/options from bundled content.
  for (const file of triviaFilesCache()) {
    const found = file.questions.find((x) => x.id === qid);
    if (found) return { id: found.id, prompt: found.prompt, options: found.options };
  }
  throw new HttpsError("internal", `Question ${qid} not found in bundled trivia.`);
}

let _triviaCache = null;
function triviaFilesCache() {
  if (_triviaCache) return _triviaCache;
  const dir = join(here, "content", "trivia");
  _triviaCache = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson(join(dir, f)));
  return _triviaCache;
}

// ============================================================================
// submitAnswer — record a player's choice (graded later, at round resolution).
// ============================================================================
export const submitAnswer = onCall(async (request) => {
  const uid = requireAuth(request);
  const { roomId, questionId, choiceIndex } = request.data || {};
  const room = await getRoomOrThrow(roomId);
  if (room.phase !== Phase.TRIVIA) throw new HttpsError("failed-precondition", "Not a trivia round.");
  if (room.question?.id !== questionId) throw new HttpsError("failed-precondition", "Stale question.");

  const pref = playersCol(roomId).doc(uid);
  if (!(await pref.get()).exists) throw new HttpsError("permission-denied", "You are not in this room.");
  // Store the choice only — never the correctness — so no answer key is exposed.
  await pref.update({ answer: { questionId, choiceIndex } });
  return { ok: true };
});

// ============================================================================
// resolveRound — host closes the round: grade, dispense public clues, route the
// wrong-answerers to the Killing Floor (or trigger a Killer Strike).
// ============================================================================
export const resolveRound = onCall(async (request) => {
  const uid = requireAuth(request);
  const roomId = request.data?.roomId;
  const room = await getRoomOrThrow(roomId);
  if (room.hostUid !== uid) throw new HttpsError("permission-denied", "Only the host can resolve.");
  if (room.phase !== Phase.TRIVIA) throw new HttpsError("failed-precondition", "Not a trivia round.");

  const secret = (await secretRef(roomId).get()).data();
  const players = await playersCol(roomId).get();
  const publicState = publicStateFromRoom(room);
  const reveals = [...(room.reveals || [])];
  const rosterUpdates = {};
  const quickenings = []; // names of Ghosts who reanimated this round (for the host beat)
  const batch = db.batch();

  const wrongAlive = [];
  const quickenedUids = new Set(); // reanimated this round — spared this round's Strike so the beat lands
  for (const p of players.docs) {
    const pd = p.data();
    const choice = pd.answer?.questionId === secret.currentQuestionId ? pd.answer.choiceIndex : null;
    const correct = choice !== null && isCorrect(secret, secret.currentQuestionId, choice);

    if (correct) {
      // Each correct answer earns one public elimination onto the corkboard.
      const clue = dispensePublicClue(secret);
      if (clue) {
        applyEffect(publicState, clue.effect);
        reveals.push({
          clueId: clue.id,
          content: clue.content,
          category: categoryOf(clue.effect, room.board),
          target: clue.effect.target || null,
          round: room.round,
          by: pd.name,
        });
      }
      // Vitality rises on every correct answer (upward-only). Track the streak.
      const streak = (pd.streak || 0) + 1;
      const vitality = (pd.vitality || 0) + 1;
      const upd = { vitality, answer: { ...pd.answer, correct: true } };
      rosterUpdates[`roster.${p.id}.vitality`] = vitality;
      if (pd.isGhost && streak >= REVIVE_STREAK) {
        // The Quickening — three in a row drags a Ghost back through the Veil.
        upd.alive = true;
        upd.isGhost = false;
        upd.streak = 0;
        upd.justQuickened = true;
        rosterUpdates[`roster.${p.id}.alive`] = true;
        rosterUpdates[`roster.${p.id}.isGhost`] = false;
        quickenings.push(pd.name);
        quickenedUids.add(p.id);
      } else {
        upd.streak = streak;
      }
      batch.update(p.ref, upd);
    } else {
      // A wrong answer never subtracts Vitality — it only stalls the streak.
      batch.update(p.ref, { streak: 0, answer: pd.answer ? { ...pd.answer, correct: false } : null });
      if (pd.alive) wrongAlive.push(p.id);
    }
  }

  const solvable = isCaseSolvable(publicState);
  const strikeEvery = room.settings?.strikeEvery ?? STRIKE_EVERY;
  const killerStrikes = strikeEvery > 0 && room.round > 0 && room.round % strikeEvery === 0;

  // Persist graded board + dispensing cursor.
  batch.update(roomRef(roomId), { cleared: publicState.cleared, reveals, solvable, quickenings });
  batch.update(secretRef(roomId), { cursors: secret.cursors });

  // Killer Strikes pulls EVERYONE (alive + ghosts, so ghosts can be revived) — except
  // anyone who just Quickened this round, so their revival beat isn't stomped. An
  // ordinary cull pulls only those who answered wrong.
  const atRisk = killerStrikes
    ? players.docs.map((p) => p.id).filter((id) => !quickenedUids.has(id))
    : wrongAlive;

  let nextPhase;
  if (atRisk.length > 0) {
    const fatalByUid = {};
    for (const id of atRisk) fatalByUid[id] = rollFatalGoblets();
    batch.update(secretRef(roomId), { killingFloorFatal: fatalByUid });
    batch.update(roomRef(roomId), {
      phase: Phase.KILLING_FLOOR,
      killingFloor: {
        active: true,
        reason: killerStrikes ? "strike" : "cull",
        label: killerStrikes ? room.title : "A wrong answer draws blood",
        goblets: GOBLETS,
        atRisk,
        resolved: {},
        survivors: [],
        dead: [],
      },
    });
    nextPhase = Phase.KILLING_FLOOR;
  } else {
    // Nobody culled: show the reveal beat, then the host advances.
    batch.update(roomRef(roomId), { phase: Phase.INTERSTITIAL });
    nextPhase = Phase.INTERSTITIAL;
  }
  Object.entries(rosterUpdates).forEach(([k, v]) => batch.update(roomRef(roomId), { [k]: v }));

  await batch.commit();
  return { phase: nextPhase, solvable, wrong: wrongAlive.length };
});

function rollFatalGoblets() {
  const fatal = new Array(GOBLETS).fill(false);
  const idx = shuffle([...Array(GOBLETS).keys()]).slice(0, FATAL_GOBLETS);
  idx.forEach((i) => (fatal[i] = true));
  return fatal;
}

function categoryOf(effect, board) {
  const id = effect.target;
  if (board.suspects.some((s) => s.id === id)) return "suspect";
  if (board.weapons.some((w) => w.id === id)) return "weapon";
  if (board.rooms.some((r) => r.id === id)) return "room";
  return effect.category || null;
}

// ============================================================================
// drinkChalice — a Killing-Floor player picks a goblet; server decides fate.
// ============================================================================
export const drinkChalice = onCall(async (request) => {
  const uid = requireAuth(request);
  const { roomId, gobletIndex } = request.data || {};
  const room = await getRoomOrThrow(roomId);
  if (room.phase !== Phase.KILLING_FLOOR) throw new HttpsError("failed-precondition", "Not on the Killing Floor.");
  const kf = room.killingFloor;
  if (!kf?.active || !kf.atRisk.includes(uid)) throw new HttpsError("permission-denied", "You are not at the table.");
  if (kf.resolved?.[uid]) throw new HttpsError("failed-precondition", "You already drank.");
  if (gobletIndex < 0 || gobletIndex >= kf.goblets) throw new HttpsError("invalid-argument", "No such goblet.");

  const secret = (await secretRef(roomId).get()).data();
  const fatal = secret.killingFloorFatal?.[uid]?.[gobletIndex] === true;

  const pref = playersCol(roomId).doc(uid);
  const pd = (await pref.get()).data();
  const wasGhost = pd.isGhost;

  const batch = db.batch();
  const resolved = { ...(kf.resolved || {}), [uid]: { gobletIndex, fatal } };
  const survivors = [...kf.survivors];
  const dead = [...kf.dead];

  const vitality = fatal ? (pd.vitality || 0) : (pd.vitality || 0) + 1; // survival is a step toward life
  if (fatal) {
    // The chalice was laced. A living sleuth joins the dead — no Vitality penalty,
    // but the revival streak resets so the comeback starts fresh.
    dead.push(uid);
    batch.update(pref, { alive: false, isGhost: true, lives: 0, streak: 0 });
    batch.update(roomRef(roomId), { [`roster.${uid}.alive`]: false, [`roster.${uid}.isGhost`]: true });
  } else {
    survivors.push(uid);
    if (wasGhost) {
      // Won the Chalice outright as a ghost → dragged back among the living (a Quickening).
      batch.update(pref, { alive: true, isGhost: false, lives: 1, streak: 0, vitality, justQuickened: true });
      batch.update(roomRef(roomId), {
        [`roster.${uid}.alive`]: true, [`roster.${uid}.isGhost`]: false, [`roster.${uid}.vitality`]: vitality,
        quickenings: FieldValue.arrayUnion(pd.name),
      });
    } else {
      // Survived a real cull → earn a scarce private lead and a step of Vitality.
      const lead = dispensePrivateClue(secret);
      const upd = { vitality };
      if (lead) {
        upd.leads = FieldValue.arrayUnion({
          clueId: lead.id,
          content: lead.content,
          category: lead.effect.category || null,
          target: lead.effect.target || null,
        });
        upd.canAccuse = true;
        batch.update(secretRef(roomId), { cursors: secret.cursors });
      }
      batch.update(pref, upd);
      batch.update(roomRef(roomId), { [`roster.${uid}.vitality`]: vitality });
    }
  }

  batch.update(roomRef(roomId), { "killingFloor.resolved": resolved, "killingFloor.survivors": survivors, "killingFloor.dead": dead });

  // When the last at-risk player has drunk, close the floor.
  const allResolved = kf.atRisk.every((id) => resolved[id]);
  if (allResolved) {
    batch.update(roomRef(roomId), { phase: Phase.INTERSTITIAL, "killingFloor.active": false });
  }

  await batch.commit();
  return { fatal, revived: !fatal && wasGhost, allResolved };
});

// ============================================================================
// nextRound — host advances from the interstitial: next question, or the finale.
// ============================================================================
export const nextRound = onCall(async (request) => {
  const uid = requireAuth(request);
  const roomId = request.data?.roomId;
  const room = await getRoomOrThrow(roomId);
  if (room.hostUid !== uid) throw new HttpsError("permission-denied", "Only the host advances.");
  if (room.phase !== Phase.INTERSTITIAL) throw new HttpsError("failed-precondition", "Nothing to advance.");

  if (room.solvable) {
    // Mark finale eligibility on every player (alive OR holding a private lead).
    const players = await playersCol(roomId).get();
    const batch = db.batch();
    players.forEach((p) => {
      const pd = p.data();
      batch.update(p.ref, { canAccuse: pd.alive || (pd.leads || []).length > 0 });
    });
    batch.update(roomRef(roomId), {
      phase: Phase.FINALE,
      question: null,
      finale: { active: true, killerProximity: 0, maxProximity: MAX_KILLER_PROXIMITY, winner: null },
    });
    await batch.commit();
    return { phase: Phase.FINALE };
  }

  await loadNextQuestion(roomId, room.round + 1);
  return { phase: Phase.TRIVIA };
});

// ============================================================================
// makeAccusation — the finale race. First correct Who+What+Where wins.
// ============================================================================
export const makeAccusation = onCall(async (request) => {
  const uid = requireAuth(request);
  const { roomId, suspect, weapon, room: roomAnswer } = request.data || {};
  const room = await getRoomOrThrow(roomId);
  if (room.phase !== Phase.FINALE) throw new HttpsError("failed-precondition", "The finale hasn't opened.");
  if (room.finale?.winner) throw new HttpsError("failed-precondition", "The case is already closed.");

  const pref = playersCol(roomId).doc(uid);
  const psnap = await pref.get();
  if (!psnap.exists) throw new HttpsError("permission-denied", "You are not in this room.");
  const pd = psnap.data();
  if (!pd.canAccuse) throw new HttpsError("permission-denied", "A ghost needs a private lead to accuse.");
  if (pd.accused) throw new HttpsError("failed-precondition", "You have already made your accusation.");

  const secret = (await secretRef(roomId).get()).data();
  const correct = checkAccusation(secret, { suspect, weapon, room: roomAnswer });

  const batch = db.batch();
  if (correct) {
    batch.update(roomRef(roomId), {
      phase: Phase.GAME_OVER,
      "finale.winner": { uid, name: pd.name },
      "finale.solution": secret.solution, // reveal only now the game is over
    });
    await batch.commit();
    return { correct: true, winner: true };
  }

  // Wrong: the Killer takes the accuser and closes in.
  const proximity = (room.finale.killerProximity || 0) + 1;
  batch.update(pref, { canAccuse: false, accused: true, alive: false, isGhost: true });
  batch.update(roomRef(roomId), {
    [`roster.${uid}.alive`]: false,
    [`roster.${uid}.isGhost`]: true,
    "finale.killerProximity": proximity,
  });
  if (proximity >= (room.finale.maxProximity || MAX_KILLER_PROXIMITY)) {
    // The Killer escapes — nobody solved it in time.
    batch.update(roomRef(roomId), {
      phase: Phase.GAME_OVER,
      "finale.winner": { uid: null, name: "The Killer" },
      "finale.solution": secret.solution,
    });
  }
  await batch.commit();
  return { correct: false, winner: false, killerProximity: proximity };
});
