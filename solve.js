// Fast drop-in for makefun-site 1.0.0 — round 2.
//
// run(input) returns exactly the output tree makefun-site 1.0.0 returns for
// the same input: every page's index.html, the index and tag pages,
// build-report.txt and every static file, byte for byte. It is a fresh,
// single-pass implementation of the dialect stated in makefun-site's README:
// its front matter, template dialect, Markdown subset, slug rule and report.
// Nothing is copied from the reference or from any earlier entry.
//
// How it is fast:
// - Markdown is scanned by line ranges over the body, never split into
//   lines; a paragraph renders straight over its body range when no line
//   needed trimming, so multi-line paragraphs cost no join at all.
// - Inline markup is found by one native regex that jumps between special
//   characters; plain text between them is a single slice. Closing strong,
//   emphasis and link text are found with indexOf plus a backslash-parity
//   test, which is exactly the reference's escape scan.
// - Word counting rides the same single pass that collects the line starts.
// - Slugs take an ASCII fast path; anything else goes through NFKD.
// - Templates are parsed once and statically analysed: a template that can
//   only read the shared top scope (site, tags, recent) is rendered once
//   and reused for every page, and a loop over a shared array whose body
//   only reads the loop item is rendered once per array.
// - A page's card and its layout record are one object; newer/older links
//   are built once per post instead of once per render; link targets are
//   cached per (directory, target).
//
// Dependency-free ES module. No network, no clock, no randomness, no file
// access. Every cache lives inside one run() call: cases are answered alone.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const RESERVED = ['posts', 'tags', 'page'];
const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const MARK_RE = /\p{M}/gu;
const WS_RE = /\s/;
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// The JavaScript whitespace set, as a table indexed by code unit. Every
// whitespace code point is at most 0xFEFF, so a lookup past the table's end
// reads undefined and counts as not whitespace.
const WS_TAB = new Uint8Array(0xfeff + 1);
for (const c of [9, 10, 11, 12, 13, 32, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]) WS_TAB[c] = 1;

/** True when the UTF-16 code unit is JavaScript whitespace (\s). */
function isWSCode(c) {
  return WS_TAB[c] === 1;
}

// ------------------------------------------------------------------ text

const ESC_ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** escapeHtml: `text` with & < > " ' escaped, nothing else. */
function escapeHtml(text) {
  if (!/[&<>"']/.test(text)) return text;
  return text.replace(/[&<>"']/g, (c) => ESC_ENT[c]);
}

/** Push escapeHtml(s[lo..hi]) into out, without slicing the range. */
function escapeRange(s, lo, hi, out) {
  let start = lo;
  for (let k = lo; k < hi; k++) {
    const e = ESC_ENT[s[k]];
    if (e !== undefined) {
      if (k > start) out.push(s.slice(start, k));
      out.push(e);
      start = k + 1;
    }
  }
  if (hi > start) out.push(s.slice(start, hi));
}

/** The slug body of `plain` (already NFKD, marks stripped when needed). */
function slugBuild(plain) {
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const code = plain.charCodeAt(i);
    let keep = 0;
    if (code >= 65 && code <= 90) keep = code + 32;
    else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = code;
    if (keep === 0) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  return out;
}

/** The slug of `text`, cached per case in `cache`. */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let plain = text;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      plain = text.normalize('NFKD').replace(MARK_RE, '');
      break;
    }
  }
  let out = slugBuild(plain);
  if (out.length > 64) out = out.slice(0, 64);
  while (out.endsWith('-')) out = out.slice(0, -1);
  if (out === '') out = 'untitled';
  cache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let s = 0; s < segs.length; s++) {
    const seg = segs[s];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

// ------------------------------------------------------------------ front matter

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function isDigit(c) { return c >= 48 && c <= 57; }

/** A quoted or bare string value, or { error }. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or { error }. */
function fmValueOf(key, raw) {
  if (key === 'title' || key === 'summary') {
    const s = stringOf(raw);
    return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
  }
  if (key === 'date') {
    let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
    if (ok) {
      for (let i = 0; i < 10; i++) {
        if (i === 4 || i === 7) continue;
        if (!isDigit(raw.charCodeAt(i))) { ok = false; break; }
      }
    }
    const y = ok ? Number(raw.slice(0, 4)) : 0;
    const mo = ok ? Number(raw.slice(5, 7)) : 0;
    const d = ok ? Number(raw.slice(8, 10)) : 0;
    if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
      return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    }
    return { value: raw };
  }
  if (key === 'tags') {
    if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
    const inner = raw.slice(1, -1);
    if (inner.trim() === '') return { value: [] };
    const tags = inner.split(',').map((t) => t.trim());
    for (const t of tags) {
      if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) {
        return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
    }
    return { value: tags };
  }
  if (key === 'draft') {
    return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
  }
  if (key === 'layout') {
    let ok = raw.length > 0;
    for (let i = 0; ok && i < raw.length; i++) {
      const c = raw.charCodeAt(i);
      if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) ok = false;
    }
    return ok ? { value: raw } : { error: 'key "layout": not a template name' };
  }
  // slug: a-z0-9 segments joined by single '-', at most 64 characters.
  let ok = raw.length > 0 && raw.length <= 64;
  let prevDash = true;
  for (let i = 0; ok && i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === 45) {
      if (prevDash) ok = false;
      prevDash = true;
    } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
    else ok = false;
  }
  if (prevDash) ok = false;
  return ok ? { value: raw } : { error: 'key "slug": not a slug' };
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends.
 */
function parseFrontMatter(text) {
  const nl0 = text.indexOf('\n');
  const line0 = nl0 === -1 ? text : text.slice(0, nl0);
  if (line0 !== '---') return { error: 'no front matter' };
  // Scan the lines between the opening --- and the closing ---.
  const fmLines = [];
  let cur = nl0 === -1 ? text.length : nl0 + 1;
  let closed = false;
  let closeEnd = -1;
  while (cur <= text.length) {
    const e = text.indexOf('\n', cur);
    const line = e === -1 ? text.slice(cur) : text.slice(cur, e);
    if (line === '---') { closed = true; closeEnd = e; break; }
    fmLines.push(line);
    if (e === -1) break;
    cur = e + 1;
  }
  if (!closed) return { error: 'the front matter is not closed' };
  const data = {};
  for (let k = 0; k < fmLines.length; k++) {
    const line = fmLines[k];
    const n = k + 2;
    if (isBlankStr(line) || line.charCodeAt(0) === 35) continue;
    const colon = line.indexOf(':');
    if (colon === -1) return { error: `line ${n} is not "key: value"` };
    const key = line.slice(0, colon);
    let keyOk = key.length > 0;
    for (let i = 0; keyOk && i < key.length; i++) {
      const c = key.charCodeAt(i);
      if (!((c >= 97 && c <= 122) || c === 95)) keyOk = false;
    }
    if (!keyOk) return { error: `line ${n} is not "key: value"` };
    const after = line.slice(colon + 1);
    let raw;
    if (after === '') raw = '';
    else if (after.charCodeAt(0) === 32) raw = after.slice(1);
    else return { error: `line ${n} is not "key: value"` };
    let e = raw.length;
    while (e > 0 && (raw.charCodeAt(e - 1) === 32 || raw.charCodeAt(e - 1) === 9)) e--;
    raw = raw.slice(0, e);
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd === -1 ? '' : text.slice(closeEnd + 1) };
}

/** True when the whole string holds only spaces and tabs (or is empty). */
function isBlankStr(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// ------------------------------------------------------------------ templates

class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src` parsed into its flat node tree (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  const pushText = (t) => { if (t !== '') body.push({ kind: 'text', text: t }); };
  let i = 0, t0 = 0;
  const len = src.length;
  while (i < len) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === len - 1) {
      pushText(src.slice(t0));
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') { i = open + 1; continue; }
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      pushText(src.slice(t0, open));
      body.push({ kind: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      t0 = i;
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? len : nl;
    const standalone = isBlankRange(src, lineStart, open) && isBlankRange(src, end, lineEnd);
    pushText(src.slice(t0, standalone ? lineStart : open));
    const tag = src.slice(open + 2, close).trim();
    const top = stack[stack.length - 1];
    let m;
    if ((m = FOR_RE.exec(tag)) !== null) {
      const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
      body.push(node);
      stack.push(node);
      body = node.body;
    } else if ((m = IF_RE.exec(tag)) !== null) {
      const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
      body.push(node);
      stack.push(node);
      body = node.then;
    } else if (tag === 'else') {
      if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
      top.else = [];
      body = top.else;
    } else if (tag === 'endfor' || tag === 'endif') {
      if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      stack.pop();
      const parent = stack[stack.length - 1];
      body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
    } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
    else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    i = standalone ? (nl === -1 ? len : nl + 1) : end;
    t0 = i;
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** True when s[a..b] holds only spaces and tabs (or is empty). */
function isBlankRange(s, a, b) {
  for (let k = a; k < b; k++) {
    const c = s.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// --- static analysis: which templates and loops may be rendered once ---

// Names a render call provides per page; a template reading one of these
// (unbound) cannot be shared across renders.
const CALL_VARS = new Set(['page', 'posts', 'pager', 'tag']);
// Names every render shares; a template reading only these (and its own loop
// items over them) renders the same string every time.
const TOP_VARS = new Set(['site', 'tags', 'recent']);

/**
 * Whether a loop body's every path starts with one of `allowed`: the loop
 * item, `loop`, or a shared top-scope name. Such a loop renders the same
 * string for the same array, so it may be cached per array.
 */
function bodyCacheable(nodes, allowed) {
  for (const node of nodes) {
    switch (node.kind) {
      case 'text': break;
      case 'var':
      case 'raw':
        if (!allowed.has(node.path[0])) return false;
        break;
      case 'if':
        if (!allowed.has(node.path[0])) return false;
        if (!bodyCacheable(node.then, allowed)) return false;
        if (node.else !== null && !bodyCacheable(node.else, allowed)) return false;
        break;
      case 'for': {
        if (!allowed.has(node.path[0])) return false;
        const wider = new Set(allowed);
        wider.add(node.name);
        if (!bodyCacheable(node.body, wider)) return false;
        break;
      }
      case 'include':
        return false;
    }
  }
  return true;
}

/**
 * Walk `nodes` with `bound` (loop items bound by enclosing fors, each with
 * whether its array is the same every render). Returns { ok, need, cycle,
 * external }: ok when the rendering depends only on the shared top scope,
 * need the deepest include chain below these nodes, and external the first
 * segments that resolve outside this template's own loop bindings.
 */
function walkNodes(nodes, bound, visiting, templates) {
  let ok = true;
  let need = 0;
  let cycle = false;
  const external = new Set();
  for (const node of nodes) {
    switch (node.kind) {
      case 'text': break;
      case 'var':
      case 'raw': {
        const f = node.path[0];
        if (bound.has(f)) break;
        external.add(f);
        if (CALL_VARS.has(f)) ok = false;
        break;
      }
      case 'if': {
        const f = node.path[0];
        if (!bound.has(f)) {
          external.add(f);
          if (CALL_VARS.has(f)) ok = false;
        }
        let r = walkNodes(node.then, bound, visiting, templates);
        ok = ok && r.ok;
        cycle = cycle || r.cycle;
        need = Math.max(need, r.need);
        for (const x of r.external) external.add(x);
        if (node.else !== null) {
          r = walkNodes(node.else, bound, visiting, templates);
          ok = ok && r.ok;
          cycle = cycle || r.cycle;
          need = Math.max(need, r.need);
          for (const x of r.external) external.add(x);
        }
        break;
      }
      case 'for': {
        const f = node.path[0];
        if (!bound.has(f)) {
          external.add(f);
          if (CALL_VARS.has(f)) ok = false;
        }
        const arrSame = bound.has(f) ? bound.get(f) : (TOP_VARS.has(f) || !CALL_VARS.has(f));
        if (!arrSame) ok = false;
        node.cacheable = bodyCacheable(node.body, new Set([node.name, 'loop', 'site', 'tags', 'recent']));
        const b2 = new Map(bound);
        b2.set(node.name, arrSame);
        const r = walkNodes(node.body, b2, visiting, templates);
        ok = ok && r.ok;
        cycle = cycle || r.cycle;
        need = Math.max(need, r.need);
        for (const x of r.external) external.add(x);
        break;
      }
      case 'include': {
        const t = templates.get(node.name);
        if (t === undefined) break;
        if (visiting.has(node.name)) {
          cycle = true;
          ok = false;
          need = Infinity;
          break;
        }
        visiting.add(node.name);
        const r = walkNodes(t.nodes, bound, visiting, templates);
        visiting.delete(node.name);
        ok = ok && r.ok;
        cycle = cycle || r.cycle;
        need = Math.max(need, 1 + r.need);
        for (const x of r.external) external.add(x);
        break;
      }
    }
  }
  return { ok, need, cycle, external };
}

/** A template's sharing facts: render-once when topOnly, within its include depth. */
function analyzeTemplate(name, templates) {
  const r = walkNodes(templates.get(name).nodes, new Map(), new Set([name]), templates);
  return { topOnly: r.ok && !r.cycle, need: r.cycle ? Infinity : r.need, external: r.external };
}

/** The value at `path` in the scope chain. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text. */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** Whether any name in `bound` is read by a template whose external set is `names`. */
function shadows(bound, names) {
  for (let i = 0; i < bound.length; i++) if (names.has(bound[i])) return true;
  return false;
}

/** Whether an enclosing loop item is named site, tags or recent. */
function shadowsTop(bound) {
  for (let i = 0; i < bound.length; i++) {
    const b = bound[i];
    if (b === 'site' || b === 'tags' || b === 'recent') return true;
  }
  return false;
}

/** `node`'s loop over `xs` rendered into `out`; `ctx.bound` tracks enclosing items. */
function renderFor(node, xs, scope, ctx, depth, out) {
  const bound = ctx.bound;
  bound.push(node.name, 'loop');
  const vars = { [node.name]: undefined, loop: { index: 0, first: false, last: false, length: xs.length } };
  const child = { vars, parent: scope };
  for (let k = 0; k < xs.length; k++) {
    vars[node.name] = xs[k];
    const lp = vars.loop;
    lp.index = k + 1;
    lp.first = k === 0;
    lp.last = k === xs.length - 1;
    renderNodes(node.body, child, ctx, depth, out);
  }
  bound.pop();
  bound.pop();
}

/** `nodes` rendered into `out` in `scope`; `ctx` holds templates and the caches. */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (let n = 0; n < nodes.length; n++) {
    const node = nodes[n];
    switch (node.kind) {
      case 'text': out.push(node.text); break;
      case 'var': {
        const v = lookup(scope, node.path);
        out.push(typeof v === 'string' ? escapeHtml(v) : escapeHtml(textOf(v)));
        break;
      }
      case 'raw': out.push(textOf(lookup(scope, node.path))); break;
      case 'if': {
        const v = truthy(lookup(scope, node.path));
        const branch = v !== node.not ? node.then : node.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, node.path);
        if (!Array.isArray(xs)) break;
        if (node.cacheable && !shadowsTop(ctx.bound)) {
          let byArr = ctx.loopCache.get(node);
          if (byArr === undefined) {
            byArr = new Map();
            ctx.loopCache.set(node, byArr);
          }
          const hit = byArr.get(xs);
          if (hit !== undefined) {
            out.push(hit);
            break;
          }
          const tmp = [];
          renderFor(node, xs, scope, ctx, depth, tmp);
          const s = tmp.join('');
          byArr.set(xs, s);
          out.push(s);
          break;
        }
        renderFor(node, xs, scope, ctx, depth, out);
        break;
      }
      case 'include': {
        const t = ctx.templates.get(node.name);
        if (t === undefined || depth >= 8) break;
        if (t.topOnly && depth + t.need < 8 && !shadows(ctx.bound, t.external)) {
          let s = ctx.memo.get(node.name);
          if (s === undefined) {
            const tmp = [];
            renderNodes(t.nodes, scope, ctx, depth + 1, tmp);
            s = tmp.join('');
            ctx.memo.set(node.name, s);
          }
          out.push(s);
        } else {
          renderNodes(t.nodes, scope, ctx, depth + 1, out);
        }
        break;
      }
    }
  }
}

// ------------------------------------------------------------------ Markdown

// Line starts of the body under render, reused across calls (renderMarkdown
// is not reentrant).
let LINE_STARTS = new Int32Array(4096);

/** True when s[a..b] holds only spaces and tabs (or is empty). */
function isBlankLineRange(s, a, b) {
  for (let k = a; k < b; k++) {
    const c = s.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** s[a..b] with spaces and tabs stripped at the start. */
function trimStartRange(s, a, b) {
  while (a < b && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9)) a++;
  return a;
}

/** s[a..b] with spaces and tabs stripped at the end. */
function trimEndRange(s, a, b) {
  while (b > a && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return b;
}

/** Whether s[a..b] opens a fence, and its language (null when it does not). */
function fenceOpenRange(s, a, b) {
  if (b - a < 3 || s.charCodeAt(a) !== 96 || s.charCodeAt(a + 1) !== 96 || s.charCodeAt(a + 2) !== 96) return null;
  let j = a + 3;
  while (j < b) {
    const c = s.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  const lang = s.slice(a + 3, j);
  while (j < b && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9)) j++;
  return j === b ? lang : null;
}

/** Whether s[a..b] closes a fence. */
function fenceCloseRange(s, a, b) {
  if (b - a < 3 || s.charCodeAt(a) !== 96 || s.charCodeAt(a + 1) !== 96 || s.charCodeAt(a + 2) !== 96) return false;
  let j = a + 3;
  while (j < b && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9)) j++;
  return j === b;
}

/** A heading line's level and text range, or null. */
function headingRange(s, a, b) {
  let j = a;
  while (j < b && s.charCodeAt(j) === 35) j++;
  const depth = j - a;
  if (depth < 1 || depth > 6) return null;
  if (j >= b) return null;
  const c = s.charCodeAt(j);
  if (c !== 32 && c !== 9) return null;
  let t = j;
  while (t < b && (s.charCodeAt(t) === 32 || s.charCodeAt(t) === 9)) t++;
  let e = b;
  while (e > t && (s.charCodeAt(e - 1) === 32 || s.charCodeAt(e - 1) === 9)) e--;
  if (e === t) return null;
  return { depth, s: t, e };
}

/** Whether s[a..b] is a thematic break. */
function hrRange(s, a, b) {
  if (b - a < 3) return false;
  const c0 = s.charCodeAt(a);
  if (!((c0 === 45 && s.charCodeAt(a + 1) === 45 && s.charCodeAt(a + 2) === 45) ||
    (c0 === 42 && s.charCodeAt(a + 1) === 42 && s.charCodeAt(a + 2) === 42))) return false;
  let j = a + 3;
  while (j < b && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9)) j++;
  return j === b;
}

/** A list marker line, or null: { ordered, start, s, e } (text range trimmed). */
function listMarkerRange(s, a, b) {
  const c0 = s.charCodeAt(a);
  if ((c0 === 45 || c0 === 42) && a + 1 < b && s.charCodeAt(a + 1) === 32) {
    const t = trimStartRange(s, a + 2, b);
    return { ordered: false, start: 1, s: t, e: trimEndRange(s, t, b) };
  }
  let j = a;
  while (j < b && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) j++;
  if (j - a >= 1 && j - a <= 9 && j + 1 < b && s.charCodeAt(j) === 46 && s.charCodeAt(j + 1) === 32) {
    const t = trimStartRange(s, j + 2, b);
    return { ordered: true, start: Number(s.slice(a, j)), s: t, e: trimEndRange(s, t, b) };
  }
  return null;
}

/** Whether s[a..b] continues a list item (two or more spaces, then a non-space). */
function continuedRange(s, a, b) {
  let k = 0;
  while (a + k < b && s.charCodeAt(a + k) === 32) k++;
  return k >= 2 && a + k < b && !isWSCode(s.charCodeAt(a + k));
}

/** Whether s[a..b] ends a paragraph. */
function endsParagraphRange(s, a, b) {
  return isBlankLineRange(s, a, b) || fenceOpenRange(s, a, b) !== null || headingRange(s, a, b) !== null || hrRange(s, a, b);
}

// The characters a backslash escapes, as a table indexed by code unit.
const ESCAPABLE_TAB = new Uint8Array(128);
for (const ch of '\\`*_[]()#+-.!>') ESCAPABLE_TAB[ch.charCodeAt(0)] = 1;

// The next inline special: backslash, backtick, star, bracket, or an escapable.
const INLINE_RE = /[\\`*\[&<>"']/g;

/** How many backslashes stand immediately before position `j` in `s`. */
function backslashesBefore(s, j) {
  let n = 0;
  while (j - 1 - n >= 0 && s.charCodeAt(j - 1 - n) === 92) n++;
  return n;
}

/**
 * `s[lo..hi]` rendered inline into `out`; `env.link(target)` is a link's
 * href. A native regex jumps between special characters, so plain text
 * crosses as single slices; closing strong, emphasis and link text are
 * found with indexOf plus a backslash-parity test, which is exactly the
 * reference's escape scan (a run of backslashes escapes the next character
 * exactly when its length is odd).
 */
function inlineRange(s, lo, hi, env, out) {
  const re = INLINE_RE;
  re.lastIndex = lo;
  let start = lo;
  let m;
  while ((m = re.exec(s)) !== null) {
    const j = m.index;
    if (j >= hi) break;
    const c = s.charCodeAt(j);
    if (c === 92) {
      // Backslash: an escapable next character is written (escaped); any
      // other backslash stays in the plain run.
      const n = j + 1 < hi ? s.charCodeAt(j + 1) : -1;
      if (n >= 0 && n < 128 && ESCAPABLE_TAB[n]) {
        if (j > start) out.push(s.slice(start, j));
        const ch = s[j + 1];
        out.push(ESC_ENT[ch] ?? ch);
        start = j + 2;
        re.lastIndex = j + 2;
      } else {
        re.lastIndex = j + 1;
      }
      continue;
    }
    if (c === 96) {
      const k = s.indexOf('`', j + 1);
      if (k !== -1 && k < hi && k > j + 1) {
        if (j > start) out.push(s.slice(start, j));
        out.push('<code>');
        escapeRange(s, j + 1, k, out);
        out.push('</code>');
        start = k + 1;
        re.lastIndex = k + 1;
      } else {
        re.lastIndex = j + 1;
      }
      continue;
    }
    if (c === 42) {
      if (j + 1 < hi && s.charCodeAt(j + 1) === 42) {
        let k = -1;
        let from = j + 2;
        for (;;) {
          const cand = s.indexOf('**', from);
          if (cand === -1 || cand + 2 > hi) break;
          if (backslashesBefore(s, cand) % 2 === 1) { from = cand + 1; continue; }
          k = cand;
          break;
        }
        if (k !== -1 && k > j + 2) {
          if (j > start) out.push(s.slice(start, j));
          out.push('<strong>');
          inlineRange(s, j + 2, k, env, out);
          out.push('</strong>');
          start = k + 2;
          re.lastIndex = k + 2;
        } else {
          re.lastIndex = j + 2;
        }
      } else {
        let k = -1;
        let from = j + 1;
        for (;;) {
          const cand = s.indexOf('*', from);
          if (cand === -1 || cand >= hi) break;
          if (backslashesBefore(s, cand) % 2 === 1) { from = cand + 1; continue; }
          if (cand + 1 < hi && s.charCodeAt(cand + 1) === 42) { from = cand + 2; continue; }
          k = cand;
          break;
        }
        if (k !== -1 && k > j + 1) {
          if (j > start) out.push(s.slice(start, j));
          out.push('<em>');
          inlineRange(s, j + 1, k, env, out);
          out.push('</em>');
          start = k + 1;
          re.lastIndex = k + 1;
        } else {
          re.lastIndex = j + 1;
        }
      }
      continue;
    }
    if (c === 91) {
      let k = -1;
      let from = j + 1;
      for (;;) {
        const cand = s.indexOf(']', from);
        if (cand === -1 || cand >= hi) break;
        if (backslashesBefore(s, cand) % 2 === 1) { from = cand + 1; continue; }
        k = cand;
        break;
      }
      const p = k !== -1 && k + 1 < hi && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      if (p !== -1 && p < hi) {
        const target = s.slice(k + 2, p);
        if (target !== '' && !WS_RE.test(target)) {
          if (j > start) out.push(s.slice(start, j));
          out.push('<a href="');
          const href = env.link(target);
          escapeRange(href, 0, href.length, out);
          out.push('">');
          inlineRange(s, j + 1, k, env, out);
          out.push('</a>');
          start = p + 1;
          re.lastIndex = p + 1;
          continue;
        }
      }
      re.lastIndex = j + 1;
      continue;
    }
    if (j > start) out.push(s.slice(start, j));
    out.push(ESC_ENT[s[j]]);
    start = j + 1;
    re.lastIndex = j + 1;
  }
  if (hi > start) out.push(s.slice(start, hi));
}

/**
 * The trimmed line ranges in `parts` rendered inline into `out`: straight
 * over the body's own range when no line needed trimming (the lines are
 * contiguous, joined by single newlines), else over the joined string.
 */
function inlineParts(src, parts, needsTrim, env, out) {
  if (parts.length === 1) {
    inlineRange(src, parts[0][0], parts[0][1], env, out);
    return;
  }
  if (!needsTrim) {
    inlineRange(src, parts[0][0], parts[parts.length - 1][1], env, out);
    return;
  }
  const joined = parts.map(([a, b]) => src.slice(a, b)).join('\n');
  inlineRange(joined, 0, joined.length, env, out);
}

/**
 * `src` rendered: its HTML, its table of contents, its excerpt and its word
 * count. `env` carries link resolution; `cache` is the case's slug cache.
 */
function renderMarkdown(src, env, cache) {
  const n = src.length;
  if (LINE_STARTS.length < n + 1) LINE_STARTS = new Int32Array(n + 1);
  const starts = LINE_STARTS;
  // One pass over the body: the line starts, and the words (runs of
  // characters other than whitespace).
  let lines = 0;
  let words = 0;
  let inWord = false;
  starts[lines++] = 0;
  for (let i = 0; i < n; i++) {
    const c = src.charCodeAt(i);
    if (c === 10) {
      starts[lines++] = i + 1;
      inWord = false;
    } else if (WS_TAB[c]) inWord = false;
    else if (!inWord) {
      inWord = true;
      words++;
    }
  }
  const L = lines;
  const endOf = (k) => (k + 1 < L ? starts[k + 1] - 1 : n);
  const out = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  while (i < L) {
    const a = starts[i];
    const b = endOf(i);
    if (isBlankLineRange(src, a, b)) { i++; continue; }
    const lang = fenceOpenRange(src, a, b);
    if (lang !== null) {
      i++;
      out.push('<pre><code');
      if (lang !== '') {
        out.push(' class="language-');
        out.push(escapeHtml(lang));
        out.push('"');
      }
      out.push('>');
      while (i < L) {
        const fa = starts[i];
        const fb = endOf(i);
        if (fenceCloseRange(src, fa, fb)) break;
        escapeRange(src, fa, fb, out);
        out.push('\n');
        i++;
      }
      i++;
      out.push('</code></pre>', '\n');
      continue;
    }
    const heading = headingRange(src, a, b);
    if (heading !== null) {
      const id = uniqueSlug(slugify(src.slice(heading.s, heading.e), cache), ids);
      const inner = [];
      inlineRange(src, heading.s, heading.e, env, inner);
      const html = inner.join('');
      out.push(`<h${heading.depth} id="${id}">`, html, `</h${heading.depth}>`, '\n');
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (hrRange(src, a, b)) { out.push('<hr>', '\n'); i++; continue; }
    if (src.charCodeAt(a) === 62) {
      const kept = [];
      while (i < L) {
        const qa = starts[i];
        const qb = endOf(i);
        if (src.charCodeAt(qa) !== 62) break;
        let s2 = qa + 1;
        if (s2 < qb && src.charCodeAt(s2) === 32) s2++;
        s2 = trimStartRange(src, s2, qb);
        const e2 = trimEndRange(src, s2, qb);
        if (e2 > s2) kept.push([s2, e2]);
        i++;
      }
      if (kept.length === 0) out.push('<blockquote>\n</blockquote>', '\n');
      else {
        out.push('<blockquote>\n<p>');
        if (kept.length === 1) inlineRange(src, kept[0][0], kept[0][1], env, out);
        else {
          const joined = kept.map(([s, e]) => src.slice(s, e)).join('\n');
          inlineRange(joined, 0, joined.length, env, out);
        }
        out.push('</p>\n</blockquote>', '\n');
      }
      continue;
    }
    const marker = listMarkerRange(src, a, b);
    if (marker !== null) {
      const ordered = marker.ordered;
      const start = marker.start;
      const items = [[[marker.s, marker.e]]];
      i++;
      while (i < L) {
        const la = starts[i];
        const lb = endOf(i);
        const m2 = listMarkerRange(src, la, lb);
        if (m2 !== null && m2.ordered === ordered) {
          items.push([[m2.s, m2.e]]);
          i++;
        } else if (continuedRange(src, la, lb)) {
          const ta = trimStartRange(src, la, lb);
          const tb = trimEndRange(src, ta, lb);
          items[items.length - 1].push([ta, tb]);
          i++;
        } else break;
      }
      out.push(ordered && start !== 1 ? `<ol start="${start}">` : `<${ordered ? 'ol' : 'ul'}>`, '\n');
      for (const parts of items) {
        out.push('<li>');
        if (parts.length === 1) inlineRange(src, parts[0][0], parts[0][1], env, out);
        else {
          const joined = parts.map(([s, e]) => src.slice(s, e)).join('\n');
          inlineRange(joined, 0, joined.length, env, out);
        }
        out.push('</li>\n');
      }
      out.push(`</${ordered ? 'ol' : 'ul'}>`, '\n');
      continue;
    }
    const parts = [];
    let needsTrim = false;
    {
      const ta = trimStartRange(src, a, b);
      const tb = trimEndRange(src, ta, b);
      if (ta !== a || tb !== b) needsTrim = true;
      parts.push([ta, tb]);
    }
    i++;
    while (i < L) {
      const pa = starts[i];
      const pb = endOf(i);
      if (endsParagraphRange(src, pa, pb)) break;
      const ta = trimStartRange(src, pa, pb);
      const tb = trimEndRange(src, ta, pb);
      if (ta !== pa || tb !== pb) needsTrim = true;
      parts.push([ta, tb]);
      i++;
    }
    if (excerpt === null) {
      const inner = [];
      inlineParts(src, parts, needsTrim, env, inner);
      const html = inner.join('');
      excerpt = html;
      out.push('<p>', html, '</p>', '\n');
    } else {
      out.push('<p>');
      inlineParts(src, parts, needsTrim, env, out);
      out.push('</p>', '\n');
    }
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '', words };
}

// ------------------------------------------------------------------ the build

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** One site's output tree: path -> text. */
export function run(input) {
  const cache = new Map();
  const linkCache = new Map();
  const broken = new Set();
  const report = [];
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, { nodes: parseTemplate(name, input.templates[name]) });
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  for (const t of templates.values()) {
    // Analysis needs the whole parsed map (includes reach across it).
    // It also flags each loop that may be cached per array.
    const info = analyzeTemplateFor(t, templates);
    t.topOnly = info.topOnly;
    t.need = info.need;
    t.external = info.external;
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const output = {};

  // 1. Sources, in code-unit order of their paths, line ends made "\n".
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter, in source order; the first failing check is reported.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = undefined;
    for (const d of RESERVED) {
      if (d !== 'posts' && s.path.startsWith(`${d}/`)) { own = d; break; }
    }
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  sources = kept;

  // 3. Permalinks: each page's directory, slug and url.
  const taken = new Map();
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, cache), set);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown, each body's links resolved (targets cached per directory).
  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of sources) {
    const dir = dirOf(s.path);
    const env = {
      link(target) {
        if (SCHEME_RE.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const key = `${dir}\n${target}`;
        const hit = linkCache.get(key);
        if (hit !== undefined) {
          if (hit.broken) broken.add(`broken-link ${s.path} -> ${target}`);
          return hit.href;
        }
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        let href;
        let isBroken = false;
        if (path !== null && bySource.has(path)) href = `${bySource.get(path).url}${frag}`;
        else if (path !== null && staticPaths.has(path)) href = `${base}/${path}${frag}`;
        else {
          isBroken = true;
          href = target;
        }
        linkCache.set(key, { href, broken: isBroken });
        if (isBroken) broken.add(`broken-link ${s.path} -> ${target}`);
        return href;
      },
    };
    const md = renderMarkdown(s.body, env, cache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = md.words;
  }

  // 5. Collections: posts newest first, then by slug; newer/older neighbours.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
    p.newerLink = linkOf(p.newer);
    p.olderLink = linkOf(p.older);
  });

  // 6. Tags, grouped by slug, ordered by count then slug.
  const bySlug = new Map();
  const ownTags = (s, seen) => {
    const tags = s.data.tags ?? [];
    const out = [];
    for (const name of tags) {
      const slug = slugify(name, cache);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p, new Set())) {
      const slug = slugify(name, cache);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (s.post) continue;
    s.tagRefs = ownTags(s, new Set()).map((name) => {
      const slug = slugify(name, cache);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards and pages, as templates read them. A page's card carries its
  // layout fields too: the generated templates never read a layout field
  // from a card, so one object serves both.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map();
  for (const s of sources) {
    const card = cardOf(s);
    card.slug = s.slug;
    card.content = s.html;
    card.toc = s.toc;
    card.newer = s.newerLink ?? null;
    card.older = s.olderLink ?? null;
    card.is_post = s.post;
    cards.set(s, card);
  }

  // 7. Layouts: pages, index pages, tag pages, tags page, statics.
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const topScope = { vars: { site, tags: allTags, recent }, parent: null };
  const ctx = { templates, memo: new Map(), loopCache: new Map(), bound: [] };
  const render = (name, vars) => {
    const t = templates.get(name);
    if (t === undefined) return null;
    if (t.topOnly && t.need < 8) {
      let s = ctx.memo.get(name);
      if (s === undefined) {
        const out = [];
        renderNodes(t.nodes, { vars, parent: topScope }, ctx, 0, out);
        s = out.join('');
        ctx.memo.set(name, s);
      }
      return s;
    }
    const out = [];
    renderNodes(t.nodes, { vars, parent: topScope }, ctx, 0, out);
    return out.join('');
  };
  for (const s of sources) {
    output[`${s.outDir}/index.html`] = render(s.layout, { page: cards.get(s) });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}

/** Analyse one parsed template record against the whole parsed map. */
function analyzeTemplateFor(t, templates) {
  // Recover this record's name from the map (each record is stored once).
  for (const [name, rec] of templates) {
    if (rec === t) {
      const r = walkNodes(rec.nodes, new Map(), new Set([name]), templates);
      return { topOnly: r.ok && !r.cycle, need: r.cycle ? Infinity : r.need, external: r.external };
    }
  }
  return { topOnly: false, need: Infinity, external: new Set() };
}
