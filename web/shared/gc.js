// Shared client glue for both views. Wires Firebase, anonymous auth, the callable
// API, and the live subscriptions. IMPORTANT: this bundle only ever READS the public
// room doc and (for players) that player's own private doc. It never imports the
// engine and never sees the secret tier — that lives only in Cloud Functions.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
  connectAuthEmulator,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  initializeFirestore,
  connectFirestoreEmulator,
  doc,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import {
  getFunctions,
  connectFunctionsEmulator,
  httpsCallable,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js";

import { firebaseConfig, USE_EMULATOR, FUNCTIONS_REGION } from "./config.js";

// 127.0.0.1 (not "localhost") avoids the macOS IPv6 ::1 mismatch — the emulators
// bind IPv4. Long-polling makes the Firestore listener robust against the emulator.
const EMU_HOST = "127.0.0.1";
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = USE_EMULATOR
  ? initializeFirestore(app, { experimentalForceLongPolling: true })
  : initializeFirestore(app, {});
const functions = getFunctions(app, FUNCTIONS_REGION);

if (USE_EMULATOR) {
  connectAuthEmulator(auth, `http://${EMU_HOST}:9099`, { disableWarnings: true });
  connectFirestoreEmulator(db, EMU_HOST, 8085);
  connectFunctionsEmulator(functions, EMU_HOST, 5001);
}

// Resolves to the signed-in uid (anonymous). Every view calls this first.
export const ready = new Promise((resolve) => {
  onAuthStateChanged(auth, (user) => user && resolve(user.uid));
  signInAnonymously(auth).catch((e) => console.error("auth failed", e));
});

// Callable API — the only way a client mutates state.
const call = (name) => httpsCallable(functions, name);
export const api = {
  createRoom: call("createRoom"),
  joinRoom: call("joinRoom"),
  startGame: call("startGame"),
  beginTrivia: call("beginTrivia"),
  submitAnswer: call("submitAnswer"),
  resolveRound: call("resolveRound"),
  advanceRound: call("advanceRound"),
  drinkChalice: call("drinkChalice"),
  nextRound: call("nextRound"),
  makeAccusation: call("makeAccusation"),
};

// Live subscriptions.
export function watchRoom(roomId, cb) {
  return onSnapshot(doc(db, "rooms", roomId), (snap) => snap.exists() && cb(snap.data()));
}
export function watchPlayer(roomId, uid, cb) {
  return onSnapshot(doc(db, "rooms", roomId, "players", uid), (snap) => snap.exists() && cb(snap.data()));
}

// Tiny helpers shared by the views.
export const $ = (sel, root = document) => root.querySelector(sel);
export const el = (tag, props = {}, ...kids) => {
  // `dataset` is a read-only accessor — set its keys individually rather than
  // letting Object.assign try (and throw) to overwrite the property.
  const { dataset, ...rest } = props;
  const node = Object.assign(document.createElement(tag), rest);
  if (dataset) for (const [k, v] of Object.entries(dataset)) node.dataset[k] = v;
  for (const k of kids.flat()) node.append(k?.nodeType ? k : document.createTextNode(k ?? ""));
  return node;
};
export const errText = (e) => e?.message?.replace(/^.*?:\s*/, "") || String(e);
