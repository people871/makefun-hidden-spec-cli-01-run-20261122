// mend: one patch tool for every AI edit format.
//
// Reads a patch in one of four shapes (a unified diff, SEARCH/REPLACE blocks, a V4A patch, or JSON
// tool calls), finds the lines each edit names even when the model's whitespace drifted, and writes
// every change or none of them. The contract is SPEC.md: the command line and exit codes, the safe
// paths, the three matching tiers, the four readers and the all-or-nothing write.
//
// Node 22, the standard library alone. Run as `node main.ts [options] [PATCH]`, with the working
// directory as the root of the tree. The last lines hand a trial over to runner.ts; keep them.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A failure that ends the run at once with exit 2 and one line of output. */
class Halt2 {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

/** One edit that could not be applied: its code and the path it concerns. */
class EditFail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

/** A line is blank when it is empty or only whitespace. */
const isBlank = (s: string): boolean => s.trim() === '';
/** Trailing spaces and tabs off. */
const trimEndST = (s: string): string => s.replace(/[ \t]+$/, '');
/** Leading and trailing spaces and tabs off. */
const trimBothST = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
/** The leading spaces and tabs of a line. */
const leadST = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/**
 * A patch's lines: its text split at `\n`, each with one trailing `\r` removed, and without the
 * empty piece after a final `\n`.
 */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const raw = text.split('\n');
  if (text.endsWith('\n')) raw.pop();
  return raw.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with `/`, holds no `\`, and none of its
 * `/`-separated segments is empty, `.` or `..`. */
function isSafePath(p: string): boolean {
  if (p === '' || p[0] === '/' || p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

/** A file's line break is CRLF when its first line feed follows a carriage return. */
function isCrlf(text: string): boolean {
  const nl = text.indexOf('\n');
  return nl > 0 && text[nl - 1] === '\r';
}

/** A file as lines: its break, its lines, and whether it ends with a break. */
interface FileModel {
  brk: string;
  lines: string[];
  finalBrk: boolean;
}

function modelOf(text: string): FileModel {
  if (text === '') return { brk: '\n', lines: [], finalBrk: false };
  const brk = isCrlf(text) ? '\r\n' : '\n';
  const parts = text.split(brk);
  const finalBrk = text.endsWith(brk);
  if (finalBrk) parts.pop();
  return { brk, lines: parts, finalBrk };
}

/** A file of no lines is written empty; otherwise its lines joined by its break, with a final
 * one exactly when it ends with one. */
function textOf(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.brk) + (m.finalBrk ? m.brk : '');
}

/**
 * The tree as the edits leave it: paths changed so far sit in `now` (null: deleted), everything
 * else is read from disk and remembered, so a path's state before the patch stays known.
 */
class WorkTree {
  private readonly disk = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves that succeeded, in the patch's order, for the `R` lines of the output. */
  readonly moves: Array<{ oldPath: string; newPath: string }> = [];

  readOriginal(p: string): string | null {
    if (!this.disk.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.disk.set(p, v);
    }
    return this.disk.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.readOriginal(p);
  }

  put(p: string, text: string | null): void {
    this.now.set(p, text);
  }
}

/** One edit: a function of the tree that throws EditFail when it cannot apply. */
type Edit = (tree: WorkTree) => void;

/** Compare one pattern line with one file line at a tier: 0 exact, 1 trailing spaces/tabs off,
 * 2 leading and trailing spaces/tabs off. */
function lineMatches(tier: number, pat: string, line: string): boolean {
  if (tier === 0) return pat === line;
  if (tier === 1) return trimEndST(pat) === trimEndST(line);
  return trimBothST(pat) === trimBothST(line);
}

/**
 * The 0-based positions where `pat` occurs in `lines` from `from` on, at `tier`; when `endOnly`,
 * only occurrences that end at the file's last line count. Occurrences may overlap.
 */
function spotsAt(lines: string[], pat: string[], tier: number, from: number, endOnly: boolean): number[] {
  const out: number[] = [];
  if (pat.length === 0) return out;
  const start = from < 0 ? 0 : from;
  for (let i = start; i + pat.length <= lines.length; i++) {
    if (endOnly && i + pat.length !== lines.length) continue;
    let ok = true;
    for (let j = 0; j < pat.length; j++) {
      if (!lineMatches(tier, pat[j]!, lines[i + j]!)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which `pat` occurs at or after
 * `from`, with its positions. */
function findTier(
  lines: string[],
  pat: string[],
  from: number,
  endOnly: boolean,
  strict: boolean,
): { tier: number; spots: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const spots = spotsAt(lines, pat, t, from, endOnly);
    if (spots.length > 0) return { tier: t, spots };
  }
  return null;
}

/**
 * One line of the replacement: `fromOld` is its index in the old lines when it is a context
 * line, and -1 when it is an added line.
 */
interface Piece {
  text: string;
  fromOld: number;
}

/**
 * The lines that replace a matched block. A context line is written as the file's own matched
 * line, never the patch's. At tier 2 every other line is re-indented: let F be the leading spaces
 * and tabs of the file's first matched line and P those of the old lines' first line; a line that
 * is not empty and not only whitespace, and starts with P, has that P replaced by F.
 */
function buildNew(
  fileLines: string[],
  at: number,
  oldLines: string[],
  pieces: Piece[],
  tier: number,
): string[] {
  const out: string[] = [];
  let prefix = '';
  let repl = '';
  if (tier === 2 && oldLines.length > 0) {
    prefix = leadST(oldLines[0]!);
    repl = leadST(fileLines[at]!);
  }
  for (const pc of pieces) {
    if (pc.fromOld >= 0) {
      out.push(fileLines[at + pc.fromOld]!);
      continue;
    }
    const t = pc.text;
    if (tier === 2 && t.trim() !== '' && t.startsWith(prefix)) out.push(repl + t.slice(prefix.length));
    else out.push(t);
  }
  return out;
}

/**
 * With `--format=auto` the format is the first of these that holds: the first non-blank line,
 * its surrounding whitespace removed, is `*** Begin Patch` (v4a); the first non-whitespace
 * character of the first non-blank line is `[` or `{` (json); some line, its trailing whitespace
 * removed, is `<<<<<<< SEARCH` (search-replace); some line starts with `diff --git `, or some
 * line starts with `--- ` and the line after it starts with `+++ ` (unified).
 */
function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) =>
        l.startsWith('diff --git ') ||
        (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC.md section 9)                                      */
/* ------------------------------------------------------------------ */

/** One JSON edit object, or null when it is not one. A wrong command or a missing or mistyped
 * key is a parse fault, so null here means the reader reports one. */
function jsonEditObject(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const path = o.path;
  if (typeof path !== 'string') return null;
  /** The file the edit needs, or the failure that says why it cannot have it. */
  const need = (tree: WorkTree): string => {
    if (!isSafePath(path)) throw new EditFail('unsafe', path);
    const t = tree.get(path);
    if (t === null) throw new EditFail('missing', path);
    return t;
  };
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return (tree) => {
      if (!isSafePath(path)) throw new EditFail('unsafe', path);
      if (tree.get(path) !== null) throw new EditFail('exists', path);
      tree.put(path, text);
    };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = need(tree);
      const crlf = isCrlf(before);
      // In a CRLF file the file's text and both strings are read with every `\r\n` as `\n`,
      // and the result is written back with `\r\n`.
      const norm = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const body = norm(before);
      const old = norm(oldStr);
      let count = 0;
      for (let k = body.indexOf(old); k >= 0; k = body.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditFail('no-match', path);
      if (count > 1) throw new EditFail('ambiguous', path);
      const at = body.indexOf(old);
      const out = body.slice(0, at) + norm(newStr) + body.slice(at + old.length);
      tree.put(path, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const atLine = o.insert_line;
    const extra = splitPatch(o.new_str);
    return (tree) => {
      const before = need(tree);
      const m = modelOf(before);
      if (atLine < 0 || atLine > m.lines.length) throw new EditFail('no-match', path);
      m.lines.splice(atLine, 0, ...extra);
      tree.put(path, textOf(m));
    };
  }
  return null;
}

/**
 * The patch is either one JSON array of edit objects, or JSON Lines: one edit object a line,
 * blank lines ignored. In array form any fault is `error: parse <the line where the array
 * starts>`; in JSON Lines form a line that does not hold one valid edit object is
 * `error: parse <that line>`.
 */
function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Halt2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Halt2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Halt2(`error: parse ${first + 1}`);
    for (const item of v) {
      const e = jsonEditObject(item);
      if (e === null) throw new Halt2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEditObject(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Halt2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)$/;
const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** One hunk: its old start A, its old lines, its new lines as pieces, and whether a `\` line
 * follows its last context or `+` line, or its last `+` line. */
interface UniHunk {
  a: number;
  oldLines: string[];
  pieces: Piece[];
  noEol: boolean;
  noEolPlus: boolean;
}

/** One section: where its paths came from (undefined: not named that way), its mode flags,
 * and its hunks. */
interface UniSection {
  gitOld: string | undefined;
  gitNew: string | undefined;
  hdrOld: string | undefined;
  hdrNew: string | undefined;
  renFrom: string | undefined;
  renTo: string | undefined;
  create: boolean;
  remove: boolean;
  hunks: UniHunk[];
}

/**
 * The path a `--- ` or `+++ ` line names: the text after the four characters, up to the first
 * tab, with surrounding spaces removed, and a leading `a/` or `b/` removed.
 */
function hdrPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  const cut = tab >= 0 ? rest.slice(0, tab) : rest;
  const t = cut.trim();
  if (t.startsWith('a/') || t.startsWith('b/')) return t.slice(2);
  return t;
}

/** A raw hunk body line: its kind and its text without the leading marker. */
interface RawBody {
  kind: string;
  text: string;
}

/**
 * The hunk body after a header: the lines that start with ` `, `-`, `+` or `\`, or are empty.
 * The body ends at the first other line, at a `diff --git ` line, at a `--- ` line followed by
 * a `+++ ` line, or at the end of the patch; empty lines at the end of a body are not part of
 * it. A `\` line refers to the body line before it.
 */
function readHunkBody(lines: string[], start: number, a: number): { hunk: UniHunk; next: number } {
  const raw: RawBody[] = [];
  let j = start;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      raw.push({ kind: l === '' ? ' ' : l[0]!, text: l === '' ? '' : l.slice(1) });
      j += 1;
      continue;
    }
    break;
  }
  while (raw.length > 0) {
    const last = raw[raw.length - 1]!;
    if (last.kind === ' ' && last.text === '') raw.pop();
    else break;
  }
  /** Whether a `\` line follows the last body line of the given kinds, if there is one. */
  const slashAfterLast = (kinds: string[]): boolean => {
    for (let k = raw.length - 1; k >= 0; k--) {
      if (!kinds.includes(raw[k]!.kind)) continue;
      return k + 1 < raw.length && raw[k + 1]!.kind === '\\';
    }
    return false;
  };
  const oldLines: string[] = [];
  const pieces: Piece[] = [];
  for (const b of raw) {
    if (b.kind === ' ') {
      oldLines.push(b.text);
      pieces.push({ text: b.text, fromOld: oldLines.length - 1 });
    } else if (b.kind === '-') {
      oldLines.push(b.text);
    } else if (b.kind === '+') {
      pieces.push({ text: b.text, fromOld: -1 });
    }
  }
  return {
    hunk: { a, oldLines, pieces, noEol: slashAfterLast([' ', '+']), noEolPlus: slashAfterLast(['+']) },
    next: j,
  };
}

/**
 * The sections of a unified patch. A section starts at a `diff --git a/<X> b/<Y>` line, or at a
 * `--- ` line followed by a `+++ ` line that is not already part of a section's header. Within
 * a section, before its first hunk, `--- `/`+++ ` name the paths, `rename from`/`rename to`
 * name them when no pair does, `new file mode` makes a creation and `deleted file mode` a
 * deletion, and any other line is ignored. A `--- ` line not followed by a `+++ ` line, inside
 * a section's header, is a parse error at the line after it. A `diff --git` line not of the
 * form above is a parse error at its line, and so is any other line starting with `@@`, and
 * a hunk before any section. Outside bodies, lines that are not part of a section header are
 * ignored.
 */
function parseUnified(lines: string[]): UniSection[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let header = false;
  let i = 0;
  const n = lines.length;
  const fresh = (): UniSection => ({
    gitOld: undefined,
    gitNew: undefined,
    hdrOld: undefined,
    hdrNew: undefined,
    renFrom: undefined,
    renTo: undefined,
    create: false,
    remove: false,
    hunks: [],
  });
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(line);
      if (m === null) throw new Halt2(`error: parse ${i + 1}`);
      cur = fresh();
      cur.gitOld = m[1]!;
      cur.gitNew = m[2]!;
      sections.push(cur);
      header = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      const nxt = lines[i + 1];
      if (nxt !== undefined && nxt.startsWith('+++ ')) {
        if (cur !== null && header && cur.hdrOld === undefined) {
          cur.hdrOld = hdrPath(line);
          cur.hdrNew = hdrPath(nxt);
          i += 2;
          continue;
        }
        cur = fresh();
        cur.hdrOld = hdrPath(line);
        cur.hdrNew = hdrPath(nxt);
        sections.push(cur);
        header = true;
        i += 2;
        continue;
      }
      if (cur !== null && header) throw new Halt2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (line.startsWith('+++ ')) {
      if (cur !== null && header && cur.hdrNew === undefined) cur.hdrNew = hdrPath(line);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Halt2(`error: parse ${i + 1}`);
      const hm = HUNK_HEAD.exec(line);
      if (hm === null) throw new Halt2(`error: parse ${i + 1}`);
      const res = readHunkBody(lines, i + 1, parseInt(hm[1]!, 10));
      cur.hunks.push(res.hunk);
      header = false;
      i = res.next;
      continue;
    }
    if (cur !== null && header) {
      if (line.startsWith('rename from ')) {
        if (cur.renFrom === undefined) cur.renFrom = line.slice(12).trim();
      } else if (line.startsWith('rename to ')) {
        if (cur.renTo === undefined) cur.renTo = line.slice(10).trim();
      } else if (line === 'new file mode' || line.startsWith('new file mode ')) {
        cur.create = true;
      } else if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) {
        cur.remove = true;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections;
}

/**
 * The section's old and new path: the `--- `/`+++ ` pair first, then `rename from`/`to`,
 * then the `diff --git` paths. `/dev/null` means no file.
 */
function resolveSection(s: UniSection): { oldP: string | null; newP: string | null } {
  const rawOld = s.hdrOld !== undefined ? s.hdrOld : s.renFrom !== undefined ? s.renFrom : s.gitOld;
  const rawNew = s.hdrNew !== undefined ? s.hdrNew : s.renTo !== undefined ? s.renTo : s.gitNew;
  return {
    oldP: rawOld === undefined || rawOld === '/dev/null' ? null : rawOld,
    newP: rawNew === undefined || rawNew === '/dev/null' ? null : rawNew,
  };
}

/**
 * The hunks of a section apply in order, each to the result of the ones before it. Let d be
 * the sum over this section's hunks applied so far of (the new lines' length minus the old
 * lines' length). When the old lines are not empty the hunk takes, of the occurrences at the
 * tier where they are found, the one whose 0-based position is nearest to A - 1 + d, the
 * earlier of two equally near; when they are empty the new lines are inserted after the first
 * A + d lines. When a hunk's matched lines run to the end of the file (or, for an empty old
 * side, the insertion is at the end), the result ends with a line break unless a `\` line
 * follows the hunk's last context or `+` line; when they do not, the file's final break stays
 * as it was.
 */
function applyUnifiedHunks(text: string, hunks: UniHunk[], strict: boolean, path: string): string {
  const m = modelOf(text);
  let d = 0;
  for (const h of hunks) {
    if (h.oldLines.length === 0) {
      const at = Math.max(0, Math.min(h.a + d, m.lines.length));
      const atEnd = at === m.lines.length;
      const fresh = h.pieces.map((pc) => pc.text);
      m.lines.splice(at, 0, ...fresh);
      if (atEnd) m.finalBrk = !h.noEol;
      d += h.pieces.length;
      continue;
    }
    const hit = findTier(m.lines, h.oldLines, 0, false, strict);
    if (hit === null) throw new EditFail('no-match', path);
    const target = h.a - 1 + d;
    let best = hit.spots[0]!;
    for (const s of hit.spots) {
      if (Math.abs(s - target) < Math.abs(best - target)) best = s;
    }
    const fresh = buildNew(m.lines, best, h.oldLines, h.pieces, hit.tier);
    const runsToEnd = best + h.oldLines.length === m.lines.length;
    m.lines.splice(best, h.oldLines.length, ...fresh);
    if (runsToEnd) m.finalBrk = !h.noEol;
    d += h.pieces.length - h.oldLines.length;
  }
  return textOf(m);
}

/** The section is one edit: a creation, a deletion, a move, or a change of the one path. */
function makeUnifiedEdit(s: UniSection, strict: boolean): Edit {
  const { oldP, newP } = resolveSection(s);
  if ((oldP === null || s.create) && newP !== null) {
    // A creation: the new path does not exist; the file is the `+` lines of all its hunks,
    // in order, written with LF breaks, and it ends with a line break unless a `\` line
    // follows its last `+` line.
    const hunks = s.hunks;
    return (tree) => {
      if (!isSafePath(newP)) throw new EditFail('unsafe', newP);
      if (tree.get(newP) !== null) throw new EditFail('exists', newP);
      const added: string[] = [];
      let endsWithBreak = true;
      let lastPlus: UniHunk | null = null;
      for (const h of hunks) {
        for (const pc of h.pieces) if (pc.fromOld === -1) added.push(pc.text);
        if (h.pieces.some((pc) => pc.fromOld === -1)) lastPlus = h;
      }
      if (lastPlus !== null && lastPlus.noEolPlus) endsWithBreak = false;
      tree.put(newP, added.length === 0 ? '' : added.join('\n') + (endsWithBreak ? '\n' : ''));
    };
  }
  if ((newP === null || s.remove) && oldP !== null) {
    // A deletion: the old path exists; it is deleted, and its hunks are not read.
    return (tree) => {
      if (!isSafePath(oldP)) throw new EditFail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new EditFail('missing', oldP);
      tree.put(oldP, null);
    };
  }
  if (oldP !== null && newP !== null && oldP !== newP) {
    // A move: the old path exists, the new path does not; the hunks are applied to the old
    // file's lines and the result is written at the new path, the old path deleted.
    return (tree) => {
      if (!isSafePath(oldP)) throw new EditFail('unsafe', oldP);
      if (!isSafePath(newP)) throw new EditFail('unsafe', newP);
      const cur = tree.get(oldP);
      if (cur === null) throw new EditFail('missing', oldP);
      if (tree.get(newP) !== null) throw new EditFail('exists', newP);
      const out = applyUnifiedHunks(cur, s.hunks, strict, oldP);
      tree.put(oldP, null);
      tree.put(newP, out);
      tree.moves.push({ oldPath: oldP, newPath: newP });
    };
  }
  if (oldP !== null) {
    // Otherwise a change of the one path, which exists.
    return (tree) => {
      if (!isSafePath(oldP)) throw new EditFail('unsafe', oldP);
      const cur = tree.get(oldP);
      if (cur === null) throw new EditFail('missing', oldP);
      tree.put(oldP, applyUnifiedHunks(cur, s.hunks, strict, oldP));
    };
  }
  return () => {};
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                           */
/* ------------------------------------------------------------------ */

/** One SEARCH/REPLACE block as an edit, applied in the patch's order. */
function makeSearchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!isSafePath(path)) throw new EditFail('unsafe', path);
    if (oldLines.length === 0) {
      // Old lines empty: the file is created with the new lines.
      if (tree.get(path) !== null) throw new EditFail('exists', path);
      tree.put(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new EditFail('missing', path);
    const m = modelOf(cur);
    const hit = findTier(m.lines, oldLines, 0, false, strict);
    if (hit === null) throw new EditFail('no-match', path);
    if (hit.spots.length > 1) throw new EditFail('ambiguous', path);
    const at = hit.spots[0]!;
    const fresh = buildNew(m.lines, at, oldLines, newLines.map((t) => ({ text: t, fromOld: -1 })), hit.tier);
    m.lines.splice(at, oldLines.length, ...fresh);
    tree.put(path, textOf(m));
  };
}

/**
 * The blocks of a patch. The three marker lines are matched with their trailing whitespace
 * removed. The path is the nearest line before the `<<<<<<< SEARCH` line, and after the
 * previous block's `>>>>>>> REPLACE` line (or the start of the patch), that is not blank and,
 * its surrounding whitespace removed, does not start with three backticks; the path is that
 * line with its surrounding whitespace removed. When there is no such line the block takes
 * the previous block's path; the first block with none is a parse error at its SEARCH line.
 * A SEARCH line with no `=======` and then `>>>>>>> REPLACE` after it is a parse error at the
 * SEARCH line. Lines outside blocks are otherwise ignored.
 */
function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevReplace; j--) {
      const l = lines[j]!;
      if (isBlank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Halt2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    let sep = -1;
    let end = -1;
    for (let j = searchLine + 1; j < n; j++) {
      const l = lines[j]!.trimEnd();
      if (l === '<<<<<<< SEARCH') break;
      if (sep < 0) {
        if (l === '=======') sep = j;
      } else if (l === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (sep < 0 || end < 0) throw new Halt2(`error: parse ${searchLine + 1}`);
    edits.push(
      makeSearchReplaceEdit(path, lines.slice(searchLine + 1, sep), lines.slice(sep + 1, end), strict),
    );
    prevPath = path;
    prevReplace = end;
    i = end + 1;
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                     */
/* ------------------------------------------------------------------ */

/** One chunk of an Update File section: its anchor (null: none), whether a `*** End of File`
 * line anchored it to the end of the file, its old lines and its new lines as pieces. */
interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  oldLines: string[];
  pieces: Piece[];
}

/** The section a `*** Add File: `, `*** Delete File: ` or `*** Update File: ` line starts. */
function v4aKind(line: string): string | null {
  if (line.startsWith('*** Add File: ')) return 'add';
  if (line.startsWith('*** Delete File: ')) return 'delete';
  if (line.startsWith('*** Update File: ')) return 'update';
  return null;
}

/** The path a V4A section or `*** Move to: ` line names: the rest of the line, its surrounding
 * spaces removed. */
function v4aPath(line: string, prefix: string): string {
  return line.slice(prefix.length).trim();
}

/**
 * The chunks of an Update File section's lines (after a `*** Move to: ` line, if it had one
 * as its first line). A chunk starts at an `@@` line, or, for the first chunk, at a body line;
 * a `*** End of File` line ends a chunk and anchors it to the end of the file. Body lines
 * start with ` `, `-` or `+`, or are empty. Any other line is a parse error at its line.
 * `base` is the 1-based number of the first line of `span` in the patch.
 */
function parseV4aChunks(span: string[], base: number): V4aChunk[] {
  const chunks: V4aChunk[] = [];
  let anchor: string | null = null;
  let eof = false;
  let body: RawBody[] = [];
  let open = false;
  let started = false;
  const flush = (): void => {
    if (!open) return;
    const oldLines: string[] = [];
    const pieces: Piece[] = [];
    for (const b of body) {
      if (b.kind === ' ') {
        oldLines.push(b.text);
        pieces.push({ text: b.text, fromOld: oldLines.length - 1 });
      } else if (b.kind === '-') {
        oldLines.push(b.text);
      } else if (b.kind === '+') {
        pieces.push({ text: b.text, fromOld: -1 });
      }
    }
    chunks.push({ anchor, eof, oldLines, pieces });
    open = false;
    body = [];
  };
  for (let k = 0; k < span.length; k++) {
    const l = span[k]!;
    if (l.startsWith('@@')) {
      flush();
      anchor = l.slice(2).trim();
      if (anchor === '') anchor = null;
      eof = false;
      body = [];
      open = true;
      started = true;
      continue;
    }
    if (l.trim() === '*** End of File') {
      if (!open) throw new Halt2(`error: parse ${base + k}`);
      eof = true;
      flush();
      continue;
    }
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (!open) {
        if (started) throw new Halt2(`error: parse ${base + k}`);
        anchor = null;
        eof = false;
        body = [];
        open = true;
        started = true;
      }
      body.push({ kind: l === '' ? ' ' : l[0]!, text: l === '' ? '' : l.slice(1) });
      continue;
    }
    throw new Halt2(`error: parse ${base + k}`);
  }
  flush();
  return chunks;
}

/**
 * One V4A section as an edit. `hi` is the 0-based index of its header line in the patch, and
 * `span` its lines after the header, with the blank lines at the end of the section already
 * taken off. An Add File section's lines start with `+` or are empty; a Delete File section
 * has no lines; an Update File section may have `*** Move to: ` as its first line, then
 * chunks, and an Update File section with no chunk and no `*** Move to:` is a parse error at
 * its Update File line.
 */
function makeV4aEdit(kind: string, path: string, span: string[], hi: number, strict: boolean): Edit {
  if (kind === 'add') {
    const out: string[] = [];
    for (let k = 0; k < span.length; k++) {
      const l = span[k]!;
      if (l.startsWith('+')) out.push(l.slice(1));
      else if (l === '') out.push('');
      else throw new Halt2(`error: parse ${hi + 2 + k}`);
    }
    // Add File: the path does not exist; the file is the section's lines, ended by a line break.
    return (tree) => {
      if (!isSafePath(path)) throw new EditFail('unsafe', path);
      if (tree.get(path) !== null) throw new EditFail('exists', path);
      tree.put(path, out.length === 0 ? '' : out.join('\n') + '\n');
    };
  }
  if (kind === 'delete') {
    if (span.length > 0) throw new Halt2(`error: parse ${hi + 2}`);
    return (tree) => {
      if (!isSafePath(path)) throw new EditFail('unsafe', path);
      if (tree.get(path) === null) throw new EditFail('missing', path);
      tree.put(path, null);
    };
  }
  let moveTo: string | null = null;
  let rest = span;
  if (span.length > 0 && span[0]!.startsWith('*** Move to: ')) {
    moveTo = v4aPath(span[0]!, '*** Move to: ');
    rest = span.slice(1);
  }
  const chunks = parseV4aChunks(rest, hi + 2 + (span.length - rest.length));
  if (chunks.length === 0 && moveTo === null) throw new Halt2(`error: parse ${hi + 1}`);
  return (tree) => {
    if (!isSafePath(path)) throw new EditFail('unsafe', path);
    const cur = tree.get(path);
    if (cur === null) throw new EditFail('missing', path);
    if (moveTo !== null) {
      if (!isSafePath(moveTo)) throw new EditFail('unsafe', moveTo);
      if (tree.get(moveTo) !== null) throw new EditFail('exists', moveTo);
    }
    const m = modelOf(cur);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        // The first line at or after the cursor equal to the anchor at the first tier
        // where one is; the cursor moves past it.
        const hit = findTier(m.lines, [ch.anchor], cursor, false, strict);
        if (hit === null) throw new EditFail('no-match', path);
        cursor = hit.spots[0]! + 1;
      }
      if (ch.oldLines.length === 0) {
        // The new lines are inserted at the cursor, or at the end of the file for an
        // end-of-file chunk.
        const at = ch.eof ? m.lines.length : cursor;
        m.lines.splice(at, 0, ...ch.pieces.map((pc) => pc.text));
        cursor = at + ch.pieces.length;
        continue;
      }
      const hit = findTier(m.lines, ch.oldLines, cursor, ch.eof, strict);
      if (hit === null) throw new EditFail('no-match', path);
      const at = hit.spots[0]!;
      const fresh = buildNew(m.lines, at, ch.oldLines, ch.pieces, hit.tier);
      m.lines.splice(at, ch.oldLines.length, ...fresh);
      cursor = at + fresh.length;
    }
    const out = textOf(m);
    if (moveTo !== null) {
      tree.put(path, null);
      tree.put(moveTo, out);
      tree.moves.push({ oldPath: path, newPath: moveTo });
    } else {
      tree.put(path, out);
    }
  };
}

/**
 * The sections of a V4A patch. The first non-blank line is `*** Begin Patch`, else a parse
 * error at that line (parse 1 when there is none), and the last non-blank line is
 * `*** End Patch`, else a parse error at the number of patch lines plus 1; both are compared
 * with their surrounding whitespace removed. Blank lines at the end of a section (before the
 * next section or `*** End Patch`) are not part of it. Blank lines between sections are
 * ignored. Any other line is a parse error at its line.
 */
function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Halt2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Halt2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && isBlank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Halt2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    const kind = v4aKind(line);
    if (kind === null) throw new Halt2(`error: parse ${i + 1}`);
    const prefix = kind === 'add' ? '*** Add File: ' : kind === 'delete' ? '*** Delete File: ' : '*** Update File: ';
    const path = v4aPath(line, prefix);
    let j = i + 1;
    while (j < last && v4aKind(lines[j]!) === null) j += 1;
    const span = lines.slice(i + 1, j);
    while (span.length > 0 && isBlank(span[span.length - 1]!)) span.pop();
    edits.push(makeV4aEdit(kind, path, span, i, strict));
    i = j;
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* Invocation, output and exit codes (SPEC.md sections 1, 2 and 10)    */
/* ------------------------------------------------------------------ */

/**
 * One run: parse the arguments, read the patch, detect and read its format, apply its edits
 * in order to the tree as earlier edits left it, and report what changed or why it failed.
 * A usage error wins over everything, and a parse error is reported before any file is looked
 * at. A failed edit changes nothing, and the edits after it still run, so every failure is
 * reported; when any edit failed no file is written.
 */
function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
      continue;
    }
    if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        if (format !== null) return { code: 2, out: ['error: usage'] };
        const v = a.slice('--format='.length);
        if (!FORMATS.includes(v)) return { code: 2, out: ['error: usage'] };
        format = v;
      } else if (a === '--check') {
        if (check) return { code: 2, out: ['error: usage'] };
        check = true;
      } else if (a === '--strict') {
        if (strict) return { code: 2, out: ['error: usage'] };
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
      continue;
    }
    pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const patchArg = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(patchArg ?? 0, 'utf8');
  } catch {
    if (patchArg !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatch(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = parseJson(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines).map((s) => makeUnifiedEdit(s, strict));
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Halt2('error: parse 1');
  } catch (e) {
    if (e instanceof Halt2) return { code: 2, out: [e.text] };
    throw e;
  }
  const tree = new WorkTree();
  const fails: EditFail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof EditFail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [
        ...fails.map((f) => `error: ${f.code} ${f.path}`),
        `failed: ${fails.length} of ${edits.length} edits`,
      ],
    };
  }
  // One line for each path whose state changed, in byte order of the paths (UTF-8). A file
  // moved by a move edit that succeeded, when its old path existed before the patch and does
  // not after it, and its new path did not exist before it and does after it, is one `R`
  // line instead of that pair's `D` and `A` lines, and sorts by the new path.
  const rows: Array<{ key: string; line: string }> = [];
  const covered = new Set<string>();
  for (const mv of tree.moves) {
    const wasOld = tree.readOriginal(mv.oldPath);
    const wasNew = tree.readOriginal(mv.newPath);
    if (wasOld !== null && wasNew === null && tree.get(mv.oldPath) === null && tree.get(mv.newPath) !== null) {
      rows.push({ key: mv.newPath, line: `R ${mv.oldPath} -> ${mv.newPath}` });
      covered.add(mv.oldPath);
      covered.add(mv.newPath);
    }
  }
  const changed: string[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')))) {
    const was = tree.readOriginal(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push(p);
    if (covered.has(p)) continue;
    rows.push({ key: p, line: was === null ? `A ${p}` : now === null ? `D ${p}` : `M ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
