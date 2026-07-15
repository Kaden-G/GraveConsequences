# src/ — engine

Pure, framework-agnostic logic. No Firestore, no UI, no secrets. CC integrates
these into Cloud Functions and the two client views.

- `engine/contentLoader.mjs` — **SERVER-ONLY.** Loads a CasePack + TriviaPacks and
  splits them into the three visibility tiers (public / private / secret). Owns
  answer grading and clue dispensing. Must never be bundled into a client.
- `engine/phases.mjs` — the room-level phase state machine as a pure reducer.
  Wire its transitions to Firestore writes; supply the guard callbacks from
  server state.

Everything solution-bearing lives behind these functions. If a value would let a
player cheat by reading it, it belongs in `secret` and stays in Cloud Functions.
