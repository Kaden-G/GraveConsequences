// SERVER-ONLY MODULE.
// This handles the SECRET tier: the sealed solution, the full clue graph, and the
// trivia answer keys. It must run ONLY inside Cloud Functions. Never bundle it into
// the host or player client. See docs/DESIGN_SPEC.md §4 (visibility model).

export function loadContent(casePack, triviaPacks) {
  const pool = triviaPacks.flatMap((p) => p.questions);

  // PUBLIC — safe to write to the shared room doc.
  const publicState = {
    caseId: casePack.meta.id,
    title: casePack.meta.title,
    briefing: casePack.briefing || null, // pre-game crime-scene narrative (public)
    victim: casePack.board.victim,
    board: {
      suspects: casePack.board.suspects,
      weapons: casePack.board.weapons,
      rooms: casePack.board.rooms,
    },
    cleared: { suspect: [], weapon: [], room: [] }, // filled as eliminations land
    // trivia sent to clients WITHOUT the answer key:
    triviaPublic: pool.map(({ id, prompt, options }) => ({ id, prompt, options })),
  };

  // SECRET — stays in Functions memory / a locked server store. Never sent to a client.
  const secret = {
    solution: casePack.solution,
    clues: Object.fromEntries(casePack.clues.map((c) => [c.id, c])),
    triviaAnswers: Object.fromEntries(pool.map((q) => [q.id, q.answerIndex])),
    dispensing: casePack.clueDispensing,
    cursors: { public: 0, private: 0 },
  };

  return { publicState, secret };
}

// Grade an answer server-side. The key never leaves this module.
export function isCorrect(secret, questionId, choiceIndex) {
  return secret.triviaAnswers[questionId] === choiceIndex;
}

// Dispense the next PUBLIC elimination (on a correct answer). Apply its effect to
// publicState.cleared, then reveal { content } on the shared board. null when exhausted.
export function dispensePublicClue(secret) {
  const q = secret.dispensing?.public?.queue || [];
  if (secret.cursors.public >= q.length) return null;
  const clue = secret.clues[q[secret.cursors.public++]];
  return { id: clue.id, content: clue.content, effect: clue.effect };
}

// Dispense the next PRIVATE lead (on Killing-Floor survival). Send ONLY to that
// player's private doc. null when exhausted.
export function dispensePrivateClue(secret) {
  const q = secret.dispensing?.private?.queue || [];
  if (secret.cursors.private >= q.length) return null;
  const clue = secret.clues[q[secret.cursors.private++]];
  return { id: clue.id, content: clue.content, effect: clue.effect };
}

// Apply a public eliminate/narrow effect to the shared board's cleared lists.
export function applyEffect(publicState, effect) {
  const cats = { suspect: publicState.board.suspects, weapon: publicState.board.weapons, room: publicState.board.rooms };
  const ids = effect.target ? [effect.target] : effect.targets || [];
  for (const id of ids)
    for (const cat of Object.keys(cats))
      if (cats[cat].some((c) => c.id === id) && !publicState.cleared[cat].includes(id))
        publicState.cleared[cat].push(id);
  return publicState;
}

// Whether the public board has narrowed enough to open the finale:
// exactly one candidate remains in each category.
export function isCaseSolvable(publicState) {
  const total = {
    suspect: publicState.board.suspects.length,
    weapon: publicState.board.weapons.length,
    room: publicState.board.rooms.length,
  };
  return ["suspect", "weapon", "room"].every(
    (cat) => total[cat] - publicState.cleared[cat].length === 1
  );
}

// Check a final accusation against the sealed solution (server-side only).
export function checkAccusation(secret, { suspect, weapon, room }) {
  const s = secret.solution;
  return s.suspect === suspect && s.weapon === weapon && s.room === room;
}
