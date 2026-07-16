// Host view — the shared TV. Creates the room, then subscribes to the PUBLIC room
// doc and renders the corkboard + the current phase's theater. Reads public state
// only; it never touches a player's private doc or the secret tier.
import { ready, api, watchRoom, el, errText } from "../shared/gc.js";

const stage = document.getElementById("stage");
const board = document.getElementById("board");
const suspectsRail = document.getElementById("suspects");
const weaponsRail = document.getElementById("weapons");
const manor = document.getElementById("manor");
const notesRail = document.getElementById("notes");
const strings = document.getElementById("strings");
const toastEl = document.getElementById("toast");

let uid = null;
let roomId = null;
let boardBuilt = false;
let seenReveals = 0;

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.add("hidden"), 3200);
}

async function boot() {
  uid = await ready;
  stage.innerHTML = `<div class="stack"><h1 class="gaslit">Opening the parlour…</h1></div>`;
  try {
    const { data } = await api.createRoom({ caseId: "ravenscourt-manor", triviaPackIds: ["general-knowledge-vol-1"] });
    roomId = data.roomId;
    watchRoom(roomId, render);
  } catch (e) {
    stage.innerHTML = `<div class="stack"><h1>Could not open the parlour</h1><p class="muted">${errText(e)}</p></div>`;
  }
}

function render(room) {
  buildBoardOnce(room);
  updateBoard(room);
  // The corkboard is empty until the investigation begins — keep the lobby focused
  // on the join address + room code (Jackbox-style), then reveal the board.
  const inLobby = room.phase === "lobby";
  board.classList.toggle("hidden", inLobby);
  stage.classList.toggle("lobby", inLobby);
  const fn = phases[room.phase] || phases.lobby;
  fn(room);
}

// ---- corkboard (built once, updated live) ---------------------------------
function tilt() { return (Math.random() * 4 - 2).toFixed(2) + "deg"; }
function monogram(name) { return name.replace(/^(Lord|Lady|Dr\.|Mr\.|Miss|Colonel|Silas)?\s*/,"").trim()[0] || "?"; }

function buildBoardOnce(room) {
  if (boardBuilt) return;
  // Build the cards once; render() controls when the board becomes visible.

  for (const s of room.board.suspects) {
    suspectsRail.append(el("div", { className: "pin suspect", dataset: { id: s.id }, style: `--tilt:${tilt()}` },
      el("div", { className: "portrait" }, monogram(s.name)),
      el("div", { className: "name" }, s.name),
      el("div", { className: "flavor" }, s.flavor || "")));
  }
  for (const w of room.board.weapons) {
    weaponsRail.append(el("div", { className: "pin weapon", dataset: { id: w.id }, style: `--tilt:${tilt()}` },
      el("div", { className: "portrait" }, "⚙"),
      el("div", { className: "name" }, w.name),
      el("div", { className: "flavor" }, w.flavor || "")));
  }
  manor.append(el("div", { className: "plate" }, "Ravenscourt Manor"));
  for (const r of room.board.rooms) {
    manor.append(el("div", { className: "region", dataset: { id: r.id, region: r.mapRegion || "nw" } },
      el("div", { className: "rname" }, r.name),
      el("div", { className: "rflavor" }, r.flavor || "")));
  }
  boardBuilt = true;
}

function updateBoard(room) {
  const cleared = room.cleared || { suspect: [], weapon: [], room: [] };
  const allCleared = new Set([...cleared.suspect, ...cleared.weapon, ...cleared.room]);
  board.querySelectorAll("[data-id]").forEach((node) => {
    const id = node.dataset.id;
    const isCleared = allCleared.has(id);
    node.classList.toggle("cleared", isCleared);
    if (isCleared && !node.querySelector(".stamp")) {
      node.append(el("div", { className: "stamp fresh" }, el("span", {}, "Cleared")));
    }
  });

  // notes rail — one pinned note per reveal
  const reveals = room.reveals || [];
  for (let i = notesRail.children.length; i < reveals.length; i++) {
    const rv = reveals[i];
    notesRail.append(el("div", { className: "note", dataset: { target: rv.target || "" }, style: `--tilt:${tilt()}` },
      rv.content, el("span", { className: "by" }, rv.by ? `— surfaced by ${rv.by}` : "")));
  }
  if (reveals.length > seenReveals) { seenReveals = reveals.length; }
  requestAnimationFrame(drawStrings);
}

// Red string from each note pin to the card it clears.
function drawStrings() {
  const brect = board.getBoundingClientRect();
  strings.setAttribute("viewBox", `0 0 ${brect.width} ${brect.height}`);
  strings.innerHTML = "";
  const notes = [...notesRail.children];
  notes.forEach((note) => {
    const targetId = note.dataset.target;
    if (!targetId) return;
    const card = board.querySelector(`[data-id="${targetId}"]`);
    if (!card) return;
    const a = note.getBoundingClientRect();
    const b = card.getBoundingClientRect();
    const x1 = a.left - brect.left + 8, y1 = a.top - brect.top + 8;
    const x2 = b.left - brect.left + b.width / 2, y2 = b.top - brect.top + b.height / 2;
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", x1); line.setAttribute("y1", y1);
    line.setAttribute("x2", x2); line.setAttribute("y2", y2);
    line.setAttribute("stroke", "rgba(160,24,24,0.72)");
    line.setAttribute("stroke-width", "2");
    strings.append(line);
  });
}
window.addEventListener("resize", () => requestAnimationFrame(drawStrings));

// ---- roster ---------------------------------------------------------------
function rosterEl(room) {
  const wrap = el("div", { className: "roster" });
  const entries = Object.values(room.roster || {});
  if (!entries.length) return el("p", { className: "muted typed" }, "Awaiting sleuths…");
  for (const p of entries) {
    wrap.append(el("div", { className: "chip" + (p.isGhost ? " ghost" : "") },
      el("span", { className: "av" }, p.avatar || "🔍"),
      el("span", { className: "nm" }, p.name),
      vitalityEl(p.vitality || 0, p.isGhost)));
  }
  return wrap;
}

// A warm Vitality glow: filled embers up to 5, brighter as it climbs. Ghosts read dim.
function vitalityEl(vitality, isGhost) {
  const pips = el("div", { className: "vit" + (isGhost ? " dim" : "") });
  const shown = Math.min(vitality, 5);
  for (let i = 0; i < 5; i++) pips.append(el("span", { className: "pip" + (i < shown ? " lit" : "") }));
  if (vitality > 5) pips.append(el("span", { className: "plus" }, "+" + (vitality - 5)));
  pips.title = `Vitality ${vitality}`;
  return pips;
}

// ---- phase theaters -------------------------------------------------------
const isHost = (room) => room.hostUid === uid;

const phases = {
  lobby(room) {
    const joinUrl = location.host + "/player";
    stage.replaceChildren(el("div", { className: "stack lobby-stack" },
      el("h1", { className: "gaslit", style: "font-size:clamp(1.8rem,4vw,3rem);margin-bottom:0.2em" }, "Grave Consequences"),
      el("p", { className: "typed muted", style: "margin:0" }, "On your phone, go to"),
      el("div", { className: "joinurl" }, joinUrl),
      el("p", { className: "typed muted", style: "margin:1.4rem 0 0" }, "and enter room code"),
      el("div", { className: "roomcode" }, room.code),
      el("div", { style: "margin-top:0.6rem" }, rosterEl(room)),
      hostBtn(room, "Begin the Investigation", () => api.startGame({ roomId }), "brass",
        Object.keys(room.roster || {}).length < 1)));
  },

  trivia(room) {
    const q = room.question;
    const secs = Math.max(0, Math.round(((q?.deadline || Date.now()) - Date.now()) / 1000));
    stage.replaceChildren(el("div", { className: "stack" },
      el("p", { className: "typed muted", style: "margin:0" }, `Round ${room.round} · interrogate the scene`),
      el("h1", { className: "gaslit" }, q?.prompt || "…"),
      el("div", { className: "options-grid" },
        ...(q?.options || []).map((o, i) => el("div", { className: "card opt" }, `${"ABCD"[i]}. ${o}`))),
      timerBar(secs, 20),
      hostBtn(room, "Close the Round", () => api.resolveRound({ roomId }), "brass")));
    tickTimer(q?.deadline);
  },

  killing_floor(room) {
    const kf = room.killingFloor || {};
    const roster = room.roster || {};
    const atRisk = (kf.atRisk || []).map((id) => roster[id]?.name || "A sleuth");
    const done = Object.keys(kf.resolved || {}).length;
    stage.replaceChildren(el("div", { className: "stack" },
      el("p", { className: "typed muted", style: "margin:0" }, kf.reason === "strike" ? "The Killer Strikes" : "The Killing Floor"),
      el("h1", { className: "gaslit" }, "The Poisoned Chalice"),
      el("p", { className: "serif-body", style: "max-width:44ch" },
        kf.reason === "strike"
          ? "The lights go out across Ravenscourt — everyone is dragged to the table."
          : "Those who faltered must drink. Some goblets are laced."),
      el("div", { className: "goblets" }, ...Array.from({ length: kf.goblets || 5 }, () => el("span", { className: "goblet" }, "🍷"))),
      el("p", { className: "typed" }, `At the table: ${atRisk.join(", ")}`),
      el("p", { className: "muted" }, `${done} of ${(kf.atRisk || []).length} have drunk…`)));
  },

  interstitial(room) {
    const recent = (room.reveals || []).slice(-3).reverse();
    const quickened = room.quickenings || [];
    stage.replaceChildren(el("div", { className: "stack" },
      el("p", { className: "typed muted", style: "margin:0" }, "New evidence pinned to the board"),
      el("h1", { className: "gaslit" }, room.solvable ? "The web narrows to one" : "The case tightens"),
      ...quickened.map((name) =>
        el("p", { className: "quicken", style: "max-width:52ch" }, `✨ ${name} draws breath — dragged back through the Veil!`)),
      ...recent.map((r) => el("p", { className: "card", style: "max-width:52ch;font-family:var(--type);font-size:0.95rem" }, r.content)),
      hostBtn(room, room.solvable ? "Call the Household Together" : "Continue the Investigation",
        () => api.nextRound({ roomId }), "brass")));
  },

  finale(room) {
    const f = room.finale || {};
    const pips = el("div", { className: "proximity" }, el("span", { className: "typed" }, "The Killer closes in "),
      ...Array.from({ length: f.maxProximity || 3 }, (_, i) =>
        el("span", { className: "pip" + (i < (f.killerProximity || 0) ? " lit" : "") })));
    stage.replaceChildren(el("div", { className: "stack" },
      el("p", { className: "typed muted", style: "margin:0" }, "The Drawing Room Accusation"),
      el("h1", { className: "gaslit" }, "Name the killer — before you are named"),
      el("p", { className: "serif-body", style: "max-width:46ch" },
        "Sleuths, lock your accusation on your phone. First correct Who + What + Where wins."),
      pips,
      rosterEl(room)));
  },

  game_over(room) {
    const f = room.finale || {};
    const sol = f.solution || {};
    const name = (list, id) => (list.find((x) => x.id === id) || {}).name || id;
    const won = f.winner && f.winner.uid;
    stage.replaceChildren(el("div", { className: "stack" },
      el("p", { className: "typed muted", style: "margin:0" }, "Case closed"),
      el("h1", { className: "gaslit" }, won ? `${f.winner.name} cracks the case!` : "The Killer escapes into the fog"),
      el("p", { className: "card", style: "max-width:52ch;font-size:1.1rem" },
        `It was ${name(room.board.suspects, sol.suspect)}, with the ${name(room.board.weapons, sol.weapon)}, in ${name(room.board.rooms, sol.room)}.`),
      sol.motive ? el("p", { className: "serif-body", style: "max-width:52ch;font-style:italic" }, sol.motive) : "",
      brightestSoulEl(room)));
  },
};

// "Brightest soul" — highest Vitality across the roster, a positive flourish at the reveal.
function brightestSoulEl(room) {
  const entries = Object.values(room.roster || {});
  if (!entries.length) return "";
  const top = entries.reduce((a, b) => ((b.vitality || 0) > (a.vitality || 0) ? b : a));
  if ((top.vitality || 0) <= 0) return "";
  return el("p", { className: "typed", style: "color:var(--brass-bright)" },
    `✨ Brightest soul: ${top.avatar || ""} ${top.name} (Vitality ${top.vitality})`);
}

function hostBtn(room, label, fn, cls = "", disabled = false) {
  if (!isHost(room)) return el("p", { className: "muted typed" }, "Waiting on the host…");
  const b = el("button", { className: cls, disabled }, label);
  b.onclick = async () => { b.disabled = true; try { await fn(); } catch (e) { toast(errText(e)); b.disabled = false; } };
  return b;
}

function timerBar(secs, total) {
  const bar = el("div", { className: "timer-bar" }, el("i", { style: `width:${Math.min(100, (secs / total) * 100)}%` }));
  bar.dataset.total = total;
  return bar;
}
function tickTimer(deadline) {
  clearInterval(tickTimer._t);
  if (!deadline) return;
  tickTimer._t = setInterval(() => {
    const bar = stage.querySelector(".timer-bar > i");
    if (!bar) return clearInterval(tickTimer._t);
    const secs = Math.max(0, (deadline - Date.now()) / 1000);
    bar.style.width = Math.min(100, (secs / 20) * 100) + "%";
    if (secs <= 0) clearInterval(tickTimer._t);
  }, 250);
}

boot();
