// Room-level phase state machine — framework-agnostic and pure.
// CC wires the transitions to Firestore writes and the guard callbacks to server
// state. Per-player alive/ghost status is orthogonal and lives on player docs.

export const Phase = {
  LOBBY: "lobby",
  BRIEFING: "briefing", // crime-scene + backstory before the first question
  TRIVIA: "trivia",
  REVEAL: "reveal", // timer closed the round — show who answered what before advancing
  KILLING_FLOOR: "killing_floor",
  INTERSTITIAL: "interstitial", // board update / narrative beat
  FINALE: "finale",
  GAME_OVER: "game_over",
};

export const Event = {
  START: "start",
  ANSWERS_IN: "answers_in",
  RESOLVE_DONE: "resolve_done",
  KILLER_STRIKES: "killer_strikes",
  FLOOR_RESOLVED: "floor_resolved",
  ACCUSATION: "accusation",
};

// transition(phase, event, ctx) -> next phase. Guards live on ctx and are supplied
// by the server: someoneWrong(), caseSolvable(), accusationCorrect().
export function transition(phase, event, ctx = {}) {
  switch (phase) {
    case Phase.LOBBY:
      if (event === Event.START) return Phase.BRIEFING;
      break;
    case Phase.BRIEFING:
      if (event === Event.RESOLVE_DONE) return Phase.TRIVIA; // host finishes the briefing
      break;
    case Phase.TRIVIA:
      if (event === Event.KILLER_STRIKES) return Phase.KILLING_FLOOR;
      // The timer (or everyone answering) closes the round into the reveal beat.
      if (event === Event.ANSWERS_IN) return Phase.REVEAL;
      break;
    case Phase.REVEAL:
      if (event === Event.RESOLVE_DONE)
        return ctx.someoneWrong?.() ? Phase.KILLING_FLOOR : Phase.INTERSTITIAL;
      break;
    case Phase.KILLING_FLOOR:
      if (event === Event.FLOOR_RESOLVED) return Phase.INTERSTITIAL;
      break;
    case Phase.INTERSTITIAL:
      if (event === Event.RESOLVE_DONE)
        return ctx.caseSolvable?.() ? Phase.FINALE : Phase.TRIVIA;
      break;
    case Phase.FINALE:
      if (event === Event.ACCUSATION && ctx.accusationCorrect?.())
        return Phase.GAME_OVER;
      break;
  }
  return phase; // no-op when the event doesn't apply to this phase
}
