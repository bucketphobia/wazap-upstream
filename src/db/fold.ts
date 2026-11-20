/**
 * The trigram index's fold, in JavaScript: what FTS5's trigram tokenizer with
 * remove_diacritics 1 does to each code point — case folding in every script
 * it knows, diacritics removed only where SQLite removes them — and nothing
 * else. The short-query scan and the hybrid query words match through this,
 * so a message a two-letter query finds is one the index would find too.
 * The table is generated from SQLite (scripts/gen-fold-table.mjs).
 */
import { FOLD_RUNS } from "./fold-table.js";

const REMOVED_DIACRITICS = new Set([
  0x0300, 0x0301, 0x0302, 0x0303, 0x0304, 0x0306, 0x0307, 0x0308, 0x0309, 0x030a, 0x030b, 0x030c,
  0x030f, 0x0311, 0x031b, 0x0323, 0x0324, 0x0325, 0x0326, 0x0327, 0x0328, 0x032d, 0x032e, 0x0330, 0x0331,
]);

function removedDiacritic(cp: number): boolean {
  return cp >= 0x0300 && cp <= 0x0331 && REMOVED_DIACRITICS.has(cp);
}

const BMP = new Uint16Array(0x10000);
const ASTRAL = new Map<number, number>();
for (let cp = 0; cp < BMP.length; cp++) BMP[cp] = cp;
for (const [first, count, delta, step] of FOLD_RUNS) {
  for (let k = 0; k < count; k++) {
    const cp = first + k * step;
    if (cp < 0x10000) BMP[cp] = cp + delta;
    else ASTRAL.set(cp, cp + delta);
  }
}

/** Every code point that folds to `target`, itself included when it folds to itself. */
function sourcesOf(target: number): number[] {
  const out: number[] = [];
  for (let cp = 0; cp < BMP.length; cp++) {
    if (BMP[cp] === target && !(cp >= 0xd800 && cp <= 0xdfff)) out.push(cp);
  }
  for (const [cp, folded] of ASTRAL) if (folded === target) out.push(cp);
  if (target >= 0x10000 && !ASTRAL.has(target)) out.push(target);
  return out;
}

export function foldCodePoint(cp: number): number {
  return cp < 0x10000 ? BMP[cp]! : (ASTRAL.get(cp) ?? cp);
}

function fold(text: string, stripMarks: boolean): string {
  let plain = true;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0x80 || (unit >= 0x41 && unit <= 0x5a)) {
      plain = false;
      break;
    }
  }
  if (plain) return text;
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (stripMarks && removedDiacritic(cp)) continue;
    const folded = foldCodePoint(cp);
    out += folded === cp ? ch : String.fromCodePoint(folded);
  }
  return out;
}

export function foldText(text: string): string {
  return fold(text, false);
}

/** Search-token folding also discards SQLite's removable combining marks. */
export function foldSearchText(text: string): string {
  return fold(text, true);
}

/**
 * A test for whether a text, folded, contains `foldedNeedle`, without
 * building the folded text: code points are folded as they are read and
 * matched against the needle's. What the short-query scan runs on every row.
 */
export function foldedMatcher(foldedNeedle: string): (text: string) => boolean {
  const needle = Array.from(foldedNeedle, (ch) => ch.codePointAt(0)!).filter((cp) => !removedDiacritic(cp));
  const m = needle.length;
  if (m === 0) return () => true;
  const last = needle[m - 1]!;
  const window = new Array<number>(m).fill(-1);
  // A text can only match if it holds one of the characters that fold to the
  // needle's rarest one; a native indexOf rules most texts out without a fold.
  let hints: string[] | null = null;
  for (const cp of new Set(needle)) {
    const sources = sourcesOf(cp);
    if (hints === null || sources.length < hints.length) hints = sources.map((source) => String.fromCodePoint(source));
  }
  const prefilter = hints !== null && hints.length <= 8 ? hints : null;
  return (text: string): boolean => {
    if (prefilter !== null && !prefilter.some((hint) => text.includes(hint))) return false;
    let filled = 0;
    let pos = 0;
    for (let i = 0; i < text.length; i++) {
      let cp = text.charCodeAt(i);
      if (cp >= 0xd800 && cp < 0xdc00 && i + 1 < text.length) {
        const low = text.charCodeAt(i + 1);
        if (low >= 0xdc00 && low < 0xe000) {
          cp = (cp - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
          i++;
        }
      }
      if (removedDiacritic(cp)) continue;
      const folded = foldCodePoint(cp);
      window[pos] = folded;
      pos = pos + 1 === m ? 0 : pos + 1;
      if (filled < m) filled++;
      if (filled === m && folded === last) {
        let match = true;
        for (let k = 0; k < m; k++) {
          if (window[(pos + k) % m] !== needle[k]) {
            match = false;
            break;
          }
        }
        if (match) return true;
      }
    }
    return false;
  };
}

export function foldedIncludes(text: string, foldedNeedle: string): boolean {
  return foldedMatcher(foldedNeedle)(text);
}
