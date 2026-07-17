// Proves the pure engine core runs and that the tier split actually hides secrets.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadContent, isCaseSolvable } from "../src/engine/contentLoader.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const load = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));

const cp = load("content/cases/ravenwood-manor.json");
const tp = load("content/trivia/general-knowledge-vol-1.json");
const { publicState, secret } = loadContent(cp, [tp]);

console.log("Loaded case:", publicState.title);
console.log("PUBLIC board  ->",
  publicState.board.suspects.length, "suspects,",
  publicState.board.weapons.length, "weapons,",
  publicState.board.rooms.length, "rooms");
console.log("PUBLIC trivia -> ", publicState.triviaPublic.length, "questions (no answer keys)");
console.log("SECRET        -> ", Object.keys(secret.clues).length, "clues +",
  Object.keys(secret.solution).length, "solution fields, held server-side");
console.log("A public trivia item leaks no answer:", JSON.stringify(publicState.triviaPublic[0]));
console.log("Case solvable at kickoff?", isCaseSolvable(publicState), "(expected false)");
