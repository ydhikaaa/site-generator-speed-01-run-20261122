// Fast drop-in for makefun-site 1.0.0.
//
// run(input) returns exactly the output tree makefun-site 1.0.0 returns for
// the same input: every page's index.html, the index and tag pages,
// build-report.txt and every static file, byte for byte. It is a fresh,
// single-pass implementation of the dialect stated in makefun-site's README:
// its front matter, template dialect, Markdown subset, slug rule and report.
// Nothing is copied from the reference: templates are parsed once into a
// flat node tree, Markdown renders straight into output buffers over index
// ranges (no token objects, no substring slicing in the hot paths), and
// slugs, headings and link targets are cached per case.
//
// Dependency-free ES module. No network, no clock, no randomness, no file
// access. Every cache lives inside one run() call: cases are answered alone.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const RESERVED = ['posts', 'tags', 'page'];
const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const MARK_RE = /\p{M}/gu;
const WS_RE = /\s/;

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** True when the UTF-16 code unit is JavaScript whitespace (\s). */
function isWSCode(c) {
  return (c >= 9 && c <= 13) || c === 32 || c === 0xa0 || c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 ||
    c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/** True when the line holds only spaces and tabs (or is empty). */
function isBlankLine(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A line with spaces and tabs stripped at both ends. */
function trimLine(s) {
  let a = 0, b = s.length;
  while (a < b && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9)) a++;
  while (b > a && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return s.slice(a, b);
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
    const c = s.charCodeAt(k);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) {
      if (k > start) out.push(s.slice(start, k));
      out.push(ESC_ENT[s[k]]);
      start = k + 1;
    }
  }
  if (hi > start) out.push(s.slice(start, hi));
}

/** The slug of `text`, cached per case in `cache`. */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  const plain = text.normalize('NFKD').replace(MARK_RE, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const code = plain.charCodeAt(i);
    let keep = '';
    if (code >= 65 && code <= 90) keep = String.fromCharCode(code + 32);
    else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = plain[i];
    if (keep === '') {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
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
    if (isBlankLine(line) || line.charCodeAt(0) === 35) continue;
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
    const standalone = isBlankLine(src.slice(lineStart, open)) && isBlankLine(src.slice(end, lineEnd));
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

/** `nodes` rendered into `out` in `scope`; `ctx` holds templates and the include depth. */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (let n = 0; n < nodes.length; n++) {
    const node = nodes[n];
    switch (node.kind) {
      case 'text': out.push(node.text); break;
      case 'var': out.push(escapeHtml(textOf(lookup(scope, node.path)))); break;
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
        for (let k = 0; k < xs.length; k++) {
          const vars = { [node.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          renderNodes(node.body, { vars, parent: scope }, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(node.name);
        if (t !== undefined && depth < 8) renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ------------------------------------------------------------------ Markdown

/** A heading line's level and text, or null. */
function headingOf(line) {
  let j = 0;
  while (j < line.length && line.charCodeAt(j) === 35) j++;
  if (j < 1 || j > 6) return null;
  if (j >= line.length || (line.charCodeAt(j) !== 32 && line.charCodeAt(j) !== 9)) return null;
  // The separator run of spaces/tabs after the #'s is not part of the text.
  let s = j;
  while (s < line.length && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  let e = line.length;
  while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  if (e === s) return null;
  return { depth: j, text: line.slice(s, e) };
}

/** Whether `line` opens a fence, and its language. */
function fenceOpenOf(line) {
  if (!line.startsWith('```')) return null;
  let j = 3;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  const lang = line.slice(3, j);
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  return j === line.length ? lang : null;
}

function fenceCloseOf(line) {
  if (!line.startsWith('```')) return false;
  let j = 3;
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  return j === line.length;
}

function hrOf(line) {
  if (!line.startsWith('---') && !line.startsWith('***')) return false;
  let j = 3;
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  return j === line.length;
}

/** Whether `line` ends a paragraph. */
function endsParagraph(line) {
  return isBlankLine(line) || fenceOpenOf(line) !== null || headingOf(line) !== null || hrOf(line);
}

/** A list marker line, or null: { ordered, start, text }. */
function listMarkerOf(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) return { ordered: false, start: 1, text: line.slice(2) };
  let j = 0;
  while (j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
  if (j >= 1 && j <= 9 && j + 1 < line.length && line.charCodeAt(j) === 46 && line.charCodeAt(j + 1) === 32) {
    return { ordered: true, start: Number(line.slice(0, j)), text: line.slice(j + 2) };
  }
  return null;
}

/** Whether `line` continues a list item (two or more spaces, then a non-space). */
function continuedOf(line) {
  let k = 0;
  while (k < line.length && line.charCodeAt(k) === 32) k++;
  return k >= 2 && k < line.length && !isWSCode(line.charCodeAt(k));
}

/** The first index from `from` where `s` holds `what` outside an escape, or -1. */
function findUnescaped(s, what, from, hi) {
  const wlen = what.length;
  for (let j = from; j <= hi - wlen; j++) {
    if (s[j] === '\\' && j + 1 < hi && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, hi) {
  for (let j = from; j < hi; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < hi && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (c !== '*') continue;
    if (s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}

/** `s[lo..hi]` rendered inline into `out`; `env.link(target)` is a link's href. */
function inlineRange(s, lo, hi, env, out) {
  let i = lo;
  while (i < hi) {
    const c = s[i];
    if (c === '\\' && i + 1 < hi && ESCAPABLE.has(s[i + 1])) {
      const n = s[i + 1];
      out.push(n === '&' ? '&amp;' : n === '<' ? '&lt;' : n === '>' ? '&gt;' : n === '"' ? '&quot;' : n === "'" ? '&#39;' : n);
      i += 2;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < hi && j > i + 1) {
        out.push('<code>');
        escapeRange(s, i + 1, j, out);
        out.push('</code>');
        i = j + 1;
      } else {
        out.push('`');
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (i + 1 < hi && s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2, hi);
        if (j !== -1 && j > i + 2) {
          out.push('<strong>');
          inlineRange(s, i + 2, j, env, out);
          out.push('</strong>');
          i = j + 2;
        } else {
          out.push('**');
          i += 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1, hi);
      if (j !== -1 && j > i + 1) {
        out.push('<em>');
        inlineRange(s, i + 1, j, env, out);
        out.push('</em>');
        i = j + 1;
      } else {
        out.push('*');
        i++;
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1, hi);
      const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m !== -1 && m < hi ? s.slice(k + 2, m) : '';
      if (m !== -1 && m < hi && target !== '' && !WS_RE.test(target)) {
        const href = env.link(target);
        out.push('<a href="');
        escapeRange(href, 0, href.length, out);
        out.push('">');
        inlineRange(s, i + 1, k, env, out);
        out.push('</a>');
        i = m + 1;
        continue;
      }
      out.push('[');
      i++;
      continue;
    }
    const code = s.charCodeAt(i);
    if (code === 38) out.push('&amp;');
    else if (code === 60) out.push('&lt;');
    else if (code === 62) out.push('&gt;');
    else if (code === 34) out.push('&quot;');
    else if (code === 39) out.push('&#39;');
    else out.push(c);
    i++;
  }
}

/**
 * `src` rendered: its HTML, its table of contents and its excerpt.
 * `env` carries link resolution; `cache` is the case's slug cache.
 */
function renderMarkdown(src, env, cache) {
  const lines = src.split('\n');
  const n = lines.length;
  const blocks = [];
  const toc = [];
  let excerpt = null;
  const ids = new Set();
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlankLine(line)) { i++; continue; }
    const lang = fenceOpenOf(line);
    if (lang !== null) {
      i++;
      const body = [];
      while (i < n && !fenceCloseOf(lines[i])) body.push(lines[i++]);
      i++;
      const out = ['<pre><code'];
      if (lang !== '') { out.push(' class="language-'); out.push(escapeHtml(lang)); out.push('"'); }
      out.push('>');
      for (const l of body) { escapeRange(l, 0, l.length, out); out.push('\n'); }
      out.push('</code></pre>');
      blocks.push(out.join(''));
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text, cache), ids);
      const inner = [];
      inlineRange(heading.text, 0, heading.text.length, env, inner);
      const html = inner.join('');
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (hrOf(line)) { blocks.push('<hr>'); i++; continue; }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let l = lines[i].slice(1);
        if (l.charCodeAt(0) === 32) l = l.slice(1);
        body.push(l);
        i++;
      }
      const kept = [];
      for (const l of body) { const t = trimLine(l); if (t !== '') kept.push(t); }
      if (kept.length === 0) blocks.push('<blockquote>\n</blockquote>');
      else {
        const inner = [];
        const joined = kept.join('\n');
        inlineRange(joined, 0, joined.length, env, inner);
        blocks.push(`<blockquote>\n<p>${inner.join('')}</p>\n</blockquote>`);
      }
      continue;
    }
    const marker = listMarkerOf(line);
    if (marker !== null) {
      const ordered = marker.ordered;
      const start = marker.start;
      const items = [[trimLine(marker.text)]];
      i++;
      while (i < n) {
        const m = listMarkerOf(lines[i]);
        if (m !== null && m.ordered === ordered) {
          items.push([trimLine(m.text)]);
          i++;
        } else if (continuedOf(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const out = [ordered && start !== 1 ? `<ol start="${start}">` : `<${ordered ? 'ol' : 'ul'}>`, '\n'];
      for (const parts of items) {
        const joined = parts.join('\n');
        const inner = [];
        inlineRange(joined, 0, joined.length, env, inner);
        out.push('<li>', inner.join(''), '</li>\n');
      }
      out.push(`</${ordered ? 'ol' : 'ul'}>`);
      blocks.push(out.join(''));
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const joined = body.join('\n');
    const inner = [];
    inlineRange(joined, 0, joined.length, env, inner);
    const html = inner.join('');
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? '' : blocks.join('\n') + '\n', toc, excerpt: excerpt ?? '' };
}

// ------------------------------------------------------------------ the build

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

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (isWSCode(text.charCodeAt(i))) inWord = false;
    else if (!inWord) { inWord = true; count++; }
  }
  return count;
}

/** One site's output tree: path -> text. */
export function run(input) {
  const cache = new Map();
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
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

  // 4. Markdown, each body's links resolved.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of sources) {
    const dir = dirOf(s.path);
    const env = {
      link(target) {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) {
          return target;
        }
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        let href;
        if (path !== null && bySource.has(path)) href = `${bySource.get(path).url}${frag}`;
        else if (path !== null && staticPaths.has(path)) href = `${base}/${path}${frag}`;
        else {
          broken.add(`broken-link ${s.path} -> ${target}`);
          href = target;
        }
        return href;
      },
    };
    const md = renderMarkdown(s.body, env, cache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections: posts newest first, then by slug; newer/older neighbours.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
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

  // Cards and pages, as templates read them.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map();
  for (const s of sources) cards.set(s, cardOf(s));

  // 7. Layouts: pages, index pages, tag pages, tags page, statics.
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, out);
    return out.join('');
  };
  for (const s of sources) {
    const page = {
      ...cards.get(s),
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = render(s.layout, { page });
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
