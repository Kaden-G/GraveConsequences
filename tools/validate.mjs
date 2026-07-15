#!/usr/bin/env node
// Grave Consequences — content validator (the "validated detector").
// Enforces the closed-world + solvability contract on every CasePack and checks
// TriviaPack sufficiency. Exits 1 on any failure so it can gate commits / CI.
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const load = (p) => JSON.parse(readFileSync(p, "utf8"));
const targetsOf = (e) => (e.target ? [e.target] : e.targets || []);

export function validateCase(cp) {
  const errs = [];
  const sus = new Set(cp.board.suspects.map((s) => s.id));
  const wpn = new Set(cp.board.weapons.map((w) => w.id));
  const rms = new Set(cp.board.rooms.map((r) => r.id));
  const board = new Set([...sus, ...wpn, ...rms]);
  const cats = { suspect: sus, weapon: wpn, room: rms };
  const clueIds = new Set(cp.clues.map((c) => c.id));
  const sol = cp.solution;

  // exactly one truth per category, present on the board
  for (const [cat, pool] of Object.entries(cats))
    if (!pool.has(sol[cat])) errs.push(`solution ${cat} '${sol[cat]}' is not on the board`);

  // closed world: every clue effect references only board ids
  for (const c of cp.clues)
    for (const t of targetsOf(c.effect))
      if (!board.has(t)) errs.push(`clue ${c.id} references off-board id '${t}'`);

  // public eliminations must narrow to exactly the solution
  const rem = { suspect: new Set(sus), weapon: new Set(wpn), room: new Set(rms) };
  for (const c of cp.clues)
    if (c.tier === "public" && c.effect.type === "eliminate")
      for (const cat of Object.keys(rem)) if (cats[cat].has(c.effect.target)) rem[cat].delete(c.effect.target);
  for (const cat of Object.keys(rem))
    if (rem[cat].size !== 1 || !rem[cat].has(sol[cat]))
      errs.push(`${cat} narrows to {${[...rem[cat]]}}, expected {${sol[cat]}}`);

  // no clue may eliminate a solution card
  const elim = new Set(cp.clues.filter((c) => c.tier === "public" && c.effect.type === "eliminate").map((c) => c.effect.target));
  for (const cat of Object.keys(cats)) if (elim.has(sol[cat])) errs.push(`a clue eliminates the SOLUTION ${cat}`);

  // dispensing queues must reference real clues and cover all public clues
  const d = cp.clueDispensing;
  const pubClues = new Set(cp.clues.filter((c) => c.tier === "public").map((c) => c.id));
  if (d) {
    for (const id of [...(d.public?.queue || []), ...(d.private?.queue || [])])
      if (!clueIds.has(id)) errs.push(`dispensing queue references missing clue '${id}'`);
    if (d.public?.queue && new Set(d.public.queue).size !== pubClues.size)
      errs.push("public dispensing queue does not match the set of public clues");
  }

  return {
    errs,
    publicClueCount: pubClues.size,
    possibilitySpace: sus.size * wpn.size * rms.size,
    narrowsTo: Object.fromEntries(Object.entries(rem).map(([k, v]) => [k, [...v][0]])),
  };
}

export function validateTriviaSufficiency(pool, publicClueCount) {
  const errs = [];
  for (const q of pool)
    if (!(q.answerIndex >= 0 && q.answerIndex < q.options.length))
      errs.push(`trivia '${q.id}' has an out-of-range answerIndex`);
  if (pool.length < publicClueCount)
    errs.push(`trivia pool (${pool.length}) < public clues (${publicClueCount}); enable more packs`);
  return errs;
}

// CLI: validate every case against the merged trivia pool.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const casesDir = join(root, "content", "cases");
  const triviaDir = join(root, "content", "trivia");
  const cases = readdirSync(casesDir).filter((f) => f.endsWith(".json")).map((f) => load(join(casesDir, f)));
  const packs = readdirSync(triviaDir).filter((f) => f.endsWith(".json")).map((f) => load(join(triviaDir, f)));
  const pool = packs.flatMap((p) => p.questions);

  let failed = false;
  for (const cp of cases) {
    const { errs, publicClueCount, possibilitySpace, narrowsTo } = validateCase(cp);
    const all = [...errs, ...validateTriviaSufficiency(pool, publicClueCount)];
    console.log(`\n[${cp.meta?.title || cp.meta?.id}]`);
    console.log(`  possibility space: ${possibilitySpace} | public clues: ${publicClueCount} | trivia pool: ${pool.length}`);
    console.log(`  narrows to: ${JSON.stringify(narrowsTo)}`);
    if (all.length) { failed = true; all.forEach((e) => console.log(`  x ${e}`)); }
    else console.log("  PASS — closed world holds, solvable, trivia sufficient");
  }
  console.log("");
  process.exit(failed ? 1 : 0);
}
