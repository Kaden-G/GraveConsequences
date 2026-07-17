// Player view — a phone. Joins a room, then subscribes to the PUBLIC room doc and
// to THIS player's own private doc (rules forbid reading anyone else's). It never
// sees the solution, other players' answers, or the secret tier.
import { ready, api, watchRoom, watchPlayer, el, errText } from "../shared/gc.js";

const app = document.getElementById("app");
const toastEl = document.getElementById("toast");

let uid = null;
let roomId = null;
let room = null;      // public room doc
let me = null;        // my private player doc
let avatar = "🔍";
let accusation = { suspect: null, weapon: null, room: null };
let lastPhase = null;

const AVATARS = ["🔍", "🕵️", "🎩", "🕯️", "⚰️", "🗝️", "🥀", "📜", "♟️", "🔮"];

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.add("hidden"), 3000);
}

async function boot() {
  uid = await ready;
  renderJoin();
}

// ---- join screen ----------------------------------------------------------
function renderJoin(err) {
  const nameInput = el("input", { id: "name", placeholder: "NAME", maxLength: 24, style: "letter-spacing:0.05em;text-transform:none;font-size:1.1rem" });
  const codeInput = el("input", { id: "code", placeholder: "CODE", maxLength: 4, style: "width:8ch" });
  codeInput.oninput = () => (codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z]/g, ""));

  const avatarRow = el("div", { className: "avatars" },
    ...AVATARS.map((a) => {
      const b = el("button", { className: a === avatar ? "sel" : "" }, a);
      b.onclick = () => { avatar = a; avatarRow.querySelectorAll("button").forEach((x) => x.classList.remove("sel")); b.classList.add("sel"); };
      return b;
    }));

  const join = el("button", { className: "brass big" }, "Enter the Manor");
  join.onclick = async () => {
    const name = nameInput.value.trim() || "Sleuth";
    const code = codeInput.value.trim();
    if (code.length !== 4) return toast("Enter the four-letter room code.");
    join.disabled = true;
    try {
      const { data } = await api.joinRoom({ code, name, avatar });
      roomId = data.roomId;
      watchRoom(roomId, (r) => { room = r; render(); });
      watchPlayer(roomId, uid, (p) => { me = p; render(); });
    } catch (e) { toast(errText(e)); join.disabled = false; }
  };

  app.replaceChildren(el("div", { className: "stack" },
    el("p", { className: "typed muted", style: "margin:0" }, "Ravenwood Manor · 1872"),
    el("h1", { className: "gaslit" }, "Join the Investigation"),
    el("p", { className: "muted" }, "Pick your mark, then your name and the room code."),
    avatarRow, nameInput, codeInput, join,
    err ? el("p", { className: "muted" }, err) : ""));
}

// ---- in-room render -------------------------------------------------------
function render() {
  if (!room || !me) return;
  const fn = views[room.phase] || views.lobby;
  fn();
  lastPhase = room.phase;
}

const views = {
  lobby() {
    app.replaceChildren(el("div", { className: "stack" },
      el("div", { style: "font-size:3rem" }, me.avatar),
      el("h1", { className: "gaslit" }, me.name),
      el("p", { className: "panel typed" }, "You're seated. Watch the parlour screen — the investigation is about to begin.")));
  },

  trivia() {
    const q = room.question;
    const answered = me.answer && me.answer.questionId === q?.id;
    const graded = answered && typeof me.answer.correct === "boolean";
    const header = el("div", { className: "stack" },
      statusBanner(),
      el("p", { className: "typed muted", style: "margin:0" }, `Round ${room.round}`),
      el("h1", { className: "gaslit", style: "font-size:1.3rem" }, q?.prompt || "…"));
    const opts = (q?.options || []).map((o, i) => {
      const mine = answered && me.answer.choiceIndex === i;
      let cls = "answer-btn";
      let icon = "";
      if (graded && mine) { cls += me.answer.correct ? " correct" : " wrong"; icon = me.answer.correct ? "✓" : "✗"; }
      else if (!graded && mine) cls += " selected"; // distinct colour for the choice you locked
      const b = el("button", { className: cls },
        el("span", {}, `${"ABCD"[i]}.  ${o}`),
        icon ? el("span", { className: "mark" }, icon) : "");
      b.disabled = answered;
      b.onclick = async () => {
        try { await api.submitAnswer({ roomId, questionId: q.id, choiceIndex: i }); toast("Answer locked."); }
        catch (e) { toast(errText(e)); }
      };
      return b;
    });
    const gradedMsg = me.answer?.correct
      ? (me.isGhost ? "Correct — the Veil thins. Keep the streak alive." : "Correct — you pinned a clue to the board.")
      : (me.isGhost ? "Wrong — your revival streak resets. Try again." : "Wrong — the Killing Floor awaits.");
    app.replaceChildren(header, el("div", { className: "stack" }, ...opts),
      graded ? el("p", { className: "panel" }, gradedMsg)
             : answered ? el("p", { className: "muted typed" }, "Locked. Await the reveal.") : "");
  },

  // At round close the phase is REVEAL — same question, now graded (✓/✗ on your pick).
  reveal() {
    views.trivia();
  },

  killing_floor() {
    const kf = room.killingFloor || {};
    const atRisk = (kf.atRisk || []).includes(uid);
    const resolved = kf.resolved && kf.resolved[uid];
    if (!atRisk) {
      if (me.justQuickened) return app.replaceChildren(panel("✨", "You draw breath again!", "Three in a row — you clawed back through the Veil while the others face the chalice."));
      return app.replaceChildren(panel(me.isGhost ? "👻" : "🕯️", me.isGhost ? "You watch from the Veil" : "You are spared",
        me.isGhost ? "Ghosts don't drink — keep answering to Quicken back. Watch the others face the chalice." : "You answered true. Watch the screen as the others drink."));
    }
    if (resolved) {
      return app.replaceChildren(panel(resolved.fatal ? "⚰️" : "🍷",
        resolved.fatal ? "The chalice was laced" : "You live",
        resolved.fatal ? "You join the dead — but ghosts still deduce." : "You survived the cull."));
    }
    const row = el("div", { className: "goblet-row" },
      ...Array.from({ length: kf.goblets || 5 }, (_, i) => {
        const g = el("button", { className: "goblet-pick" }, "🍷");
        g.onclick = async () => {
          row.querySelectorAll("button").forEach((x) => (x.disabled = true));
          try { const { data } = await api.drinkChalice({ roomId, gobletIndex: i }); toast(data.fatal ? "Laced…" : data.revived ? "Back among the living!" : "You live."); }
          catch (e) { toast(errText(e)); row.querySelectorAll("button").forEach((x) => (x.disabled = false)); }
        };
        return g;
      }));
    app.replaceChildren(el("div", { className: "stack" },
      el("p", { className: "typed muted", style: "margin:0" }, "The Poisoned Chalice"),
      el("h1", { className: "gaslit" }, "Choose a goblet"),
      el("p", {}, "Some are laced with arsenic. Choose, and drink."),
      row));
  },

  interstitial() {
    app.replaceChildren(el("div", { className: "stack" },
      statusBanner(),
      el("p", { className: "typed muted", style: "margin:0" }, "Your private leads"),
      el("h1", { className: "gaslit", style: "font-size:1.4rem" }, "Case notebook"),
      leadsEl(),
      el("p", { className: "muted typed" }, "The board updates on the parlour screen.")));
  },

  finale() {
    if (!me.canAccuse) {
      return app.replaceChildren(panel("👻", "You may only watch", "A ghost needs at least one private lead to make the final accusation."));
    }
    if (me.accused) {
      return app.replaceChildren(panel("🔒", "Accusation made", "You have named your killer. Watch the screen."));
    }
    const groups = [
      ["suspect", "Who", room.board.suspects],
      ["weapon", "What", room.board.weapons],
      ["room", "Where", room.board.rooms],
    ];
    const submit = el("button", { className: "brass big", disabled: true }, "Lock the Accusation");
    const refresh = () => (submit.disabled = !(accusation.suspect && accusation.weapon && accusation.room));
    const groupEls = groups.map(([cat, label, list]) =>
      el("div", { className: "acc-group" },
        el("h3", {}, label),
        el("div", { className: "acc-options" }, ...list.map((item) => {
          const b = el("button", { className: accusation[cat] === item.id ? "sel" : "" }, item.name);
          b.onclick = () => {
            accusation[cat] = item.id;
            b.parentElement.querySelectorAll("button").forEach((x) => x.classList.remove("sel"));
            b.classList.add("sel"); refresh();
          };
          return b;
        }))));
    submit.onclick = async () => {
      submit.disabled = true;
      try {
        const { data } = await api.makeAccusation({ roomId, ...accusation });
        toast(data.correct ? "Correct — you've solved it!" : "Wrong — the Killer takes you.");
      } catch (e) { toast(errText(e)); refresh(); }
    };
    app.replaceChildren(el("div", { className: "stack" },
      el("p", { className: "typed muted", style: "margin:0" }, "The Drawing Room Accusation"),
      el("h1", { className: "gaslit", style: "font-size:1.4rem" }, "Name the killer"),
      leadsEl(),
      ...groupEls, submit));
  },

  game_over() {
    const f = room.finale || {};
    const won = f.winner && f.winner.uid === uid;
    app.replaceChildren(panel(won ? "🏆" : "⚰️",
      won ? "You cracked the case!" : (f.winner?.uid ? `${f.winner.name} solved it` : "The Killer escaped"),
      "Return to the parlour screen for the full reveal."));
  },
};

// Loud state feedback: fresh Quickening, ghost + revival progress, or living Vitality.
function statusBanner() {
  const vitality = me.vitality || 0;
  if (me.justQuickened) {
    return el("div", { className: "status quickened" },
      el("div", { style: "font-size:2rem" }, "✨"),
      el("strong", {}, "You draw breath again!"),
      el("span", {}, "Three in a row — you clawed back through the Veil. You are among the living."));
  }
  if (me.isGhost) {
    const streak = me.streak || 0;
    const pips = el("div", { className: "revive-pips" });
    for (let i = 0; i < 3; i++) pips.append(el("span", { className: "rp" + (i < streak ? " lit" : "") }));
    return el("div", { className: "status ghost" },
      el("div", { style: "font-size:1.8rem" }, "👻"),
      el("strong", {}, "You are a ghost"),
      el("span", {}, `Answer ${3 - streak} more in a row to Quicken back to life:`),
      pips,
      el("span", { className: "vitline" }, `Vitality ${vitality}`));
  }
  return el("div", { className: "status living" },
    el("span", {}, "❤ Living"), el("span", { className: "vitline" }, `Vitality ${vitality}`));
}

function leadsEl() {
  const leads = me.leads || [];
  if (!leads.length) return el("p", { className: "muted typed" }, "No private leads yet — survive the Killing Floor to earn one.");
  return el("div", { className: "leads" }, ...leads.map((l) =>
    el("div", { className: "lead" }, el("span", { className: "tag" }, l.category || "lead"), l.content)));
}

function panel(icon, title, body) {
  return el("div", { className: "stack" },
    el("div", { style: "font-size:3rem" }, icon),
    el("h1", { className: "gaslit" }, title),
    el("p", { className: "panel" }, body));
}

boot();
