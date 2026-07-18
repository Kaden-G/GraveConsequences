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
let currentRoom = null;
let hostLoopStarted = false;
let briefingBeat = 0; // host-paced position in the crime-scene briefing
const firing = { resolve: -1, advance: -1 }; // guard: fire each host action once per round

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
    const { data } = await api.createRoom({ caseId: "ravenwood-manor", triviaPackIds: ["general-knowledge-vol-1"] });
    roomId = data.roomId;
    watchRoom(roomId, render);
  } catch (e) {
    stage.innerHTML = `<div class="stack"><h1>Could not open the parlour</h1><p class="muted">${errText(e)}</p></div>`;
  }
}

function render(room) {
  currentRoom = room;
  startHostLoop();
  buildBoardOnce(room);
  updateBoard(room);
  // The corkboard is empty until the investigation begins — keep the lobby + briefing
  // focused (join code, then the crime-scene story), then reveal the board.
  const preGame = room.phase === "lobby" || room.phase === "briefing";
  board.classList.toggle("hidden", preGame);
  stage.classList.toggle("lobby", preGame);
  const fn = phases[room.phase] || phases.lobby;
  fn(room);
}

// The host TV drives the round clock: it auto-closes trivia (timer up or everyone
// answered) and auto-advances past the reveal beat. Fires each action once per round.
function startHostLoop() {
  if (hostLoopStarted) return;
  hostLoopStarted = true;
  setInterval(() => {
    const room = currentRoom;
    if (!room || room.hostUid !== uid) return;
    // Auto-close the answer window (timer up or everyone in). The reveal that
    // follows does NOT auto-advance — the host advances it manually so the group
    // has time to study the board.
    if (room.phase === "trivia" && room.question) {
      const total = Object.keys(room.roster || {}).length;
      const allAnswered = total > 0 && (room.answeredUids || []).length >= total;
      const timeUp = Date.now() >= (room.question.deadline || 0);
      if ((timeUp || allAnswered) && firing.resolve !== room.round) {
        firing.resolve = room.round;
        api.resolveRound({ roomId }).catch(() => (firing.resolve = -1));
      }
    }
  }, 400);
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
  if (room.map && room.map.image) {
    // The illustrated floor plan, with an invisible hotspot over each candidate room
    // so cleared stamps + red string anchor to the true location on the map.
    manor.classList.add("manor-photo");
    manor.append(el("img", { className: "manor-map-img", src: "../" + room.map.image, alt: "Ravenwood Manor floor plan" }));
    const boxes = room.map.rooms || {};
    for (const r of room.board.rooms) {
      const b = boxes[r.id];
      if (!b) continue;
      // A room may map to one box, or several (e.g. the grouped guest rooms).
      for (const box of Array.isArray(b) ? b : [b]) {
        manor.append(el("div", {
          className: "room-hotspot", dataset: { id: r.id }, title: r.name,
          style: `left:${box.x}%;top:${box.y}%;width:${box.w}%;height:${box.h}%`,
        }));
      }
    }
  } else {
    // Fallback: the CSS-drawn manor grid (rooms as regions).
    manor.append(el("div", { className: "plate" }, "Ravenwood Manor"));
    for (const r of room.board.rooms) {
      manor.append(el("div", { className: "region", dataset: { id: r.id, region: r.mapRegion || "nw" } },
        el("div", { className: "rname" }, r.name),
        el("div", { className: "rflavor" }, r.flavor || "")));
    }
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

  // The crime-scene briefing — host walks the beats, then opens the interrogation.
  briefing(room) {
    const b = room.briefing;
    if (!b || !(b.beats || []).length) {
      return stage.replaceChildren(el("div", { className: "stack" },
        hostBtn(room, "Begin the Interrogation", () => api.beginTrivia({ roomId }), "brass")));
    }
    const beats = b.beats;
    const i = Math.min(briefingBeat, beats.length - 1);
    const beat = beats[i] || {};
    const last = i >= beats.length - 1;

    const dots = el("div", { className: "beat-dots" },
      ...beats.map((_, k) => el("span", { className: "bd" + (k <= i ? " on" : "") })));

    const btn = el("button", { className: "brass", style: "font-size:1.1rem" }, last ? "Begin the Interrogation" : "Continue");
    btn.onclick = async () => {
      if (last) {
        btn.disabled = true;
        try { await api.beginTrivia({ roomId }); } catch (e) { toast(errText(e)); btn.disabled = false; }
      } else {
        briefingBeat = i + 1;
        phases.briefing(currentRoom);
      }
    };
    const control = isHost(room) ? btn : el("p", { className: "muted typed" }, "The host is presenting the case…");

    stage.replaceChildren(el("div", { className: "stack briefing-stack" },
      el("p", { className: "typed muted", style: "margin:0" }, b.subtitle || ""),
      el("h1", { className: "gaslit" }, b.title || "The Case"),
      el("div", { className: "card briefing-card" },
        el("h2", { className: "gaslit", style: "font-size:1.4rem;margin-bottom:0.4em" }, beat.heading || ""),
        el("p", { className: "serif-body", style: "font-size:1.2rem;line-height:1.55" }, beat.body || "")),
      el("p", { className: "typed", style: "color:var(--brass-bright);margin:0" }, `The deceased — ${room.victim?.name || ""}`),
      dots,
      control));
  },

  trivia(room) {
    const q = room.question;
    const secs = Math.max(0, Math.round(((q?.deadline || Date.now()) - Date.now()) / 1000));
    const answered = (room.answeredUids || []).length;
    const total = Object.keys(room.roster || {}).length;
    stage.replaceChildren(el("div", { className: "stack" },
      el("p", { className: "typed muted", style: "margin:0" }, `Round ${room.round} · interrogate the scene`),
      el("h1", { className: "gaslit" }, q?.prompt || "…"),
      el("div", { className: "options-grid" },
        ...(q?.options || []).map((o, i) => el("div", { className: "card opt" }, `${"ABCD"[i]}. ${o}`))),
      timerBar(secs, 20),
      el("p", { className: "typed muted" }, `${answered} of ${total} answered · the round closes when the clock runs out`)));
    tickTimer(q?.deadline);
  },

  // The reveal beat: each sleuth's avatar lands on the tile they chose; the true
  // answer glows green, wrong picks red. Auto-advances (host loop) after a few seconds.
  reveal(room) {
    const q = room.question;
    const rr = room.roundResult || { correctIndex: -1, answers: {} };
    const roster = room.roster || {};
    const byOption = {};
    for (const [pid, ci] of Object.entries(rr.answers || {})) (byOption[ci] = byOption[ci] || []).push(roster[pid] || {});
    const tiles = (q?.options || []).map((o, i) => {
      const correct = i === rr.correctIndex;
      const pickers = byOption[i] || [];
      return el("div", { className: "reveal-tile" + (correct ? " correct" : pickers.length ? " wrong" : "") },
        el("div", { className: "opt-label" }, `${"ABCD"[i]}. ${o}`, correct ? el("span", { className: "mark" }, " ✓") : ""),
        el("div", { className: "pickers" }, ...pickers.map((p) => el("span", { className: "picker-av" }, p.avatar || "🔍"))));
    });
    const clueLanded = (room.roundResult && Object.keys(room.roundResult.answers || {}).length >= 0) &&
      (room.reveals || []).some((r) => r.round === room.round);
    stage.replaceChildren(el("div", { className: "stack" },
      el("p", { className: "typed muted", style: "margin:0" }, "Time's up — the answers"),
      el("h1", { className: "gaslit", style: "font-size:1.3rem" }, q?.prompt || ""),
      el("div", { className: "reveal-grid" }, ...tiles),
      el("p", { className: "typed muted", style: "margin:0.2rem 0 0" },
        clueLanded ? "New evidence is on the board — study it, then continue." : "No new evidence — the group must do better."),
      hostBtn(room, "Continue the Investigation", () => api.advanceRound({ roomId }), "brass")));
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
          ? "The lights go out across Ravenwood — everyone is dragged to the table."
          : "Those who faltered must drink. Some goblets are laced."),
      el("div", { className: "goblets" }, ...Array.from({ length: kf.goblets || 5 }, () => el("span", { className: "goblet" }, "🍷"))),
      el("p", { className: "typed" }, `At the table: ${atRisk.join(", ")}`),
      el("p", { className: "muted" }, `${done} of ${(kf.atRisk || []).length} have drunk…`)));
  },

  // Only reached for something the board can't say on its own: a Quickening, the
  // finale opening, or the aftermath of a cull. Normal clue rounds flow straight on.
  interstitial(room) {
    const quickened = room.quickenings || [];
    const kids = quickened.map((name) =>
      el("p", { className: "quicken", style: "max-width:52ch" }, `✨ ${name} draws breath — dragged back through the Veil!`));
    if (room.solvable) {
      kids.push(el("p", { className: "typed muted", style: "margin:0" }, "Every card but one is struck from the board"));
      kids.push(el("h1", { className: "gaslit" }, "The web narrows to one"));
      kids.push(hostBtn(room, "Call the Household Together", () => api.nextRound({ roomId }), "brass"));
    } else {
      if (!quickened.length) kids.push(el("p", { className: "typed muted", style: "margin:0" }, "The survivors return to the investigation"));
      kids.push(hostBtn(room, "Continue the Investigation", () => api.nextRound({ roomId }), "brass"));
    }
    stage.replaceChildren(el("div", { className: "stack" }, ...kids));
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
