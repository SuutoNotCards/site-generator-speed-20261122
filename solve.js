// A faster drop-in for makefun-site 1.0.0's build(input): the same output tree, byte for byte.
// Templates are compiled to closures with their names resolved statically, template parts that read only
// per-site values are rendered once per build, and Markdown inline text is escaped in runs, not per character.
// Everything is built afresh for each call of run(): nothing is kept from one case to the next.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const hasOwn = Object.hasOwn;

// ---------------------------------------------------------------- text

const ESC_TEST = /[&<>"']/;
const ESC_ALL = /[&<>"']/g;
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escOne = (c) => ESCAPES[c];
function escapeHtml(s) {
  return ESC_TEST.test(s) ? s.replace(ESC_ALL, escOne) : s;
}

const NON_ASCII = /[^\x00-\x7f]/;
const MARKS = /\p{M}/gu;
function slugify(text) {
  const plain = NON_ASCII.test(text) ? text.normalize('NFKD').replace(MARKS, '') : text;
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  if (out.length > 64) out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

// JavaScript's \s, as a code-unit test.
function isSpace(c) {
  if (c <= 32) return c === 32 || (c >= 9 && c <= 13);
  if (c < 0xa0) return false;
  return c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0, len = text.length; i < len; i++) {
    if (isSpace(text.charCodeAt(i))) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;
const BLANK = /^[ \t]*$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
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
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

// `text` has "\n" line ends. Returns { data, body } or { error }.
function parseFrontMatter(text) {
  if (!text.startsWith('---') || (text.length > 3 && text.charCodeAt(3) !== 10)) return { error: 'no front matter' };
  // Find the closing line "---".
  let pos = text.length === 3 ? 3 : 4;
  let close = -1;
  let bodyStart = -1;
  while (pos <= text.length) {
    let nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    if (end - pos === 3 && text.startsWith('---', pos)) {
      close = pos;
      bodyStart = nl === -1 ? text.length : nl + 1;
      break;
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (close === -1 || text.length === 3) return { error: 'the front matter is not closed' };
  const data = {};
  const fm = close - 4 <= 0 ? [] : text.slice(4, close - 1).split('\n');
  for (let k = 0; k < fm.length; k++) {
    const line = fm[k];
    if (BLANK.test(line) || line.startsWith('#')) continue;
    const m = LINE.exec(line);
    if (!m) return { error: `line ${k + 2} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!hasOwn(data, 'title')) return { error: 'no title' };
  // The body: the lines after the closing one, joined by "\n" (a missing trailing line is "").
  const body = bodyStart >= text.length && text.charCodeAt(text.length - 1) !== 10 ? '' : text.slice(bodyStart);
  return { data, body };
}

// ---------------------------------------------------------------- Markdown

const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;
const TRIM = /^[ \t]+|[ \t]+$/g;

function trimLine(line) {
  const n = line.length;
  if (n === 0) return line;
  const a = line.charCodeAt(0);
  const z = line.charCodeAt(n - 1);
  if (a !== 32 && a !== 9 && z !== 32 && z !== 9) return line;
  return line.replace(TRIM, '');
}

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function headingOf(line) {
  if (line.charCodeAt(0) !== 35) return null;
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

function isFenceOpen(line) {
  return line.charCodeAt(0) === 96 && FENCE_OPEN.test(line);
}

function isHr(line) {
  const c = line.charCodeAt(0);
  return (c === 45 || c === 42) && HR.test(line);
}

const ESCAPABLE = new Uint8Array(128);
for (const ch of '\\`*_[]()#+-.!>') ESCAPABLE[ch.charCodeAt(0)] = 1;
const escapable = (c) => c < 128 && ESCAPABLE[c] === 1;

function findUnescaped(s, what, from) {
  const w0 = what.charCodeAt(0);
  for (let j = from; j <= s.length - what.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && escapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c === w0 && (what.length === 1 || s.startsWith(what, j))) return j;
  }
  return -1;
}

function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && escapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

const SPECIAL = /[\\`*[]/g;
const WS = /\s/;

function inline(s, link) {
  let out = '';
  let i = 0;
  const len = s.length;
  while (i < len) {
    SPECIAL.lastIndex = i;
    const m = SPECIAL.exec(s);
    const p = m === null ? len : m.index;
    if (p > i) out += escapeHtml(s.slice(i, p));
    if (p >= len) break;
    i = p;
    const c = s.charCodeAt(i);
    if (c === 92) {
      if (i + 1 < len && escapable(s.charCodeAt(i + 1))) {
        out += escapeHtml(s[i + 1]);
        i += 2;
      } else {
        out += '\\';
        i++;
      }
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        out += `<code>${escapeHtml(s.slice(i + 1, j))}</code>`;
        i = j + 1;
      } else {
        out += '`';
        i++;
      }
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          out += `<strong>${inline(s.slice(i + 2, j), link)}</strong>`;
          i = j + 2;
        } else {
          out += '**';
          i += 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        out += `<em>${inline(s.slice(i + 1, j), link)}</em>`;
        i = j + 1;
      } else {
        out += '*';
        i++;
      }
      continue;
    }
    // '['
    const k = findUnescaped(s, ']', i + 1);
    const mm = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
    const target = mm === -1 ? '' : s.slice(k + 2, mm);
    if (target !== '' && !WS.test(target)) {
      out += `<a href="${escapeHtml(link(target))}">${inline(s.slice(i + 1, k), link)}</a>`;
      i = mm + 1;
      continue;
    }
    out += '[';
    i++;
  }
  return out;
}

function renderMarkdown(src, link) {
  const lines = src.split('\n');
  const n = lines.length;
  const ids = new Set();
  let html = '';
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    if (c0 === 96) {
      const fence = FENCE_OPEN.exec(line);
      if (fence !== null) {
        i++;
        const lang = fence[1];
        let body = '';
        while (i < n && !(lines[i].charCodeAt(0) === 96 && FENCE_CLOSE.test(lines[i]))) body += `${escapeHtml(lines[i++])}\n`;
        i++;
        html += lang === '' ? `<pre><code>${body}</code></pre>\n` : `<pre><code class="language-${escapeHtml(lang)}">${body}</code></pre>\n`;
        continue;
      }
    }
    if (c0 === 35) {
      const h = headingOf(line);
      if (h !== null) {
        const id = uniqueSlug(slugify(h.text), ids);
        const ih = inline(h.text, link);
        html += `<h${h.depth} id="${id}">${ih}</h${h.depth}>\n`;
        if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html: ih });
        i++;
        continue;
      }
    }
    if ((c0 === 45 || c0 === 42) && HR.test(line)) {
      html += '<hr>\n';
      i++;
      continue;
    }
    if (c0 === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        const t = trimLine(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
        if (t !== '') body.push(t);
      }
      html += body.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(body.join('\n'), link)}</p>\n</blockquote>\n`;
      continue;
    }
    let bullet = null;
    let ordered = null;
    if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) bullet = BULLET.exec(line);
    else if (c0 >= 48 && c0 <= 57) ordered = ORDERED.exec(line);
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const marker = isOrdered ? ORDERED : BULLET;
      const items = [];
      while (i < n) {
        const m = marker.exec(lines[i]);
        if (m !== null) {
          items.push(trimLine(isOrdered ? m[2] : m[1]));
          i++;
        } else if (CONTINUED.test(lines[i])) {
          items[items.length - 1] += `\n${trimLine(lines[i])}`;
          i++;
        } else break;
      }
      const start = isOrdered ? Number(ordered[1]) : 1;
      let s = isOrdered ? (start !== 1 ? `<ol start="${start}">\n` : '<ol>\n') : '<ul>\n';
      for (const item of items) s += `<li>${inline(item, link)}</li>\n`;
      html += s + (isOrdered ? '</ol>\n' : '</ul>\n');
      continue;
    }
    let text = trimLine(line);
    i++;
    while (i < n) {
      const l = lines[i];
      if (isBlank(l) || isFenceOpen(l) || headingOf(l) !== null || isHr(l)) break;
      text += `\n${trimLine(l)}`;
      i++;
    }
    const ph = inline(text, link);
    if (excerpt === null) excerpt = ph;
    html += `<p>${ph}</p>\n`;
  }
  return { html, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

const INCLUDE_DEPTH = 8;
const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = BLANK.test(src.slice(lineStart, open)) && BLANK.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
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
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// The names whose values differ between renders of one build; every other top-level name is the build's own.
const DYNAMIC = new Set(['page', 'posts', 'pager', 'tag']);

// Runtime state of a render: `top` (the page's values) and `fr`, per open loop: [element, index, array].
// A compiled piece is fn(top, fr) -> string, with `dyn` true when its output can differ between renders.

function restOf(v, path) {
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function loopObj(f) {
  return { index: f[1] + 1, first: f[1] === 0, last: f[1] === f[2].length - 1, length: f[2].length };
}

// A getter for `path` under the static loop names `frames` (innermost last), and whether it is dynamic.
function compilePath(path, frames) {
  const first = path[0];
  for (let lv = frames.length - 1; lv >= 0; lv--) {
    if (first === 'loop') {
      if (path.length === 2) {
        const p = path[1];
        if (p === 'index') return { get: (top, fr) => fr[lv][1] + 1, dyn: true };
        if (p === 'first') return { get: (top, fr) => fr[lv][1] === 0, dyn: true };
        if (p === 'last') return { get: (top, fr) => fr[lv][1] === fr[lv][2].length - 1, dyn: true };
        if (p === 'length') return { get: (top, fr) => fr[lv][2].length, dyn: true };
      }
      return { get: (top, fr) => restOf(loopObj(fr[lv]), path), dyn: true };
    }
    if (frames[lv] === first) {
      if (path.length === 1) return { get: (top, fr) => fr[lv][0], dyn: true };
      if (path.length === 2) {
        const p = path[1];
        return {
          get: (top, fr) => {
            const v = fr[lv][0];
            return v !== null && typeof v === 'object' && hasOwn(v, p) ? v[p] : undefined;
          },
          dyn: true,
        };
      }
      return { get: (top, fr) => restOf(fr[lv][0], path), dyn: true };
    }
  }
  const dyn = DYNAMIC.has(first);
  if (path.length === 1) return { get: (top) => (hasOwn(top, first) ? top[first] : undefined), dyn };
  if (path.length === 2) {
    const p = path[1];
    return {
      get: (top) => {
        if (!hasOwn(top, first)) return undefined;
        const v = top[first];
        return v !== null && typeof v === 'object' && hasOwn(v, p) ? v[p] : undefined;
      },
      dyn,
    };
  }
  return { get: (top) => (hasOwn(top, first) ? restOf(top[first], path) : undefined), dyn };
}

function makeCompiler(templates) {
  const cache = new Map();

  // A template (by name) compiled under `frames` at include depth `depth`.
  function compileTemplate(name, frames, depth) {
    const key = `${name}\0${depth}\0${frames.join('\0')}`;
    let c = cache.get(key);
    if (c !== undefined) return c;
    // Placeholder for recursion: resolved after compiling.
    const holder = { fn: null, dyn: true };
    cache.set(key, { fn: (top, fr) => holder.fn(top, fr), dyn: true, holder });
    const r = compileList(templates.get(name), frames, depth);
    holder.fn = r.fn;
    c = { fn: r.fn, dyn: r.dyn };
    cache.set(key, c);
    return c;
  }

  function memo(piece) {
    if (piece.dyn) return piece;
    const f = piece.fn;
    let done = false;
    let val = '';
    return {
      fn: (top, fr) => {
        if (!done) {
          val = f(top, fr);
          done = true;
        }
        return val;
      },
      dyn: false,
    };
  }

  function compileNode(n, frames, depth) {
    switch (n.kind) {
      case 'text': {
        const t = n.text;
        return { fn: () => t, dyn: false, text: t };
      }
      case 'var': {
        const g = compilePath(n.path, frames);
        const get = g.get;
        return {
          fn: (top, fr) => {
            const v = get(top, fr);
            return typeof v === 'string' ? escapeHtml(v) : escapeHtml(textOf(v));
          },
          dyn: g.dyn,
        };
      }
      case 'raw': {
        const g = compilePath(n.path, frames);
        const get = g.get;
        return { fn: (top, fr) => textOf(get(top, fr)), dyn: g.dyn };
      }
      case 'if': {
        const g = compilePath(n.path, frames);
        const get = g.get;
        const a = compileList(n.then, frames, depth);
        const b = n.else === null ? null : compileList(n.else, frames, depth);
        const not = n.not;
        const af = a.fn;
        const bf = b === null ? null : b.fn;
        return memo({
          fn: (top, fr) => {
            const v = truthy(get(top, fr));
            if (v !== not) return af(top, fr);
            return bf === null ? '' : bf(top, fr);
          },
          dyn: g.dyn || a.dyn || (b !== null && b.dyn),
        });
      }
      case 'for': {
        const g = compilePath(n.path, frames);
        const get = g.get;
        const inner = [...frames, n.name];
        const body = compileList(n.body, inner, depth);
        const bf = body.fn;
        return memo({
          fn: (top, fr) => {
            const xs = get(top, fr);
            if (!Array.isArray(xs)) return '';
            const f = [undefined, 0, xs];
            const fr2 = [...fr, f];
            let out = '';
            for (let k = 0; k < xs.length; k++) {
              f[0] = xs[k];
              f[1] = k;
              out += bf(top, fr2);
            }
            return out;
          },
          // A body that reads its own loop's values is still constant when the array is.
          dyn: g.dyn || body.dynOuter(frames.length),
        });
      }
      case 'include': {
        if (!templates.has(n.name) || depth >= INCLUDE_DEPTH) return { fn: () => '', dyn: false, text: '' };
        const t = compileTemplate(n.name, frames, depth + 1);
        return memo({ fn: (top, fr) => t.fn(top, fr), dyn: t.dyn });
      }
    }
  }

  // Compiles a list; `dyn` is whether it reads per-render values. Loop-variable reads count as dynamic, except
  // that dynOuter(level) tells whether it reads anything per-render other than loops opened at or past `level`.
  function compileList(nodes, frames, depth) {
    const pieces = [];
    let dyn = false;
    for (const n of nodes) {
      const p = compileNode(n, frames, depth);
      if (p.dyn) dyn = true;
      const last = pieces[pieces.length - 1];
      if (p.text !== undefined && last !== undefined && last.text !== undefined) {
        const t = last.text + p.text;
        pieces[pieces.length - 1] = { fn: () => t, dyn: false, text: t };
      } else pieces.push(p);
    }
    const fns = pieces.map((p) => p.fn);
    let fn;
    if (fns.length === 0) fn = () => '';
    else if (fns.length === 1) fn = fns[0];
    else if (fns.length === 2) {
      const [a, b] = fns;
      fn = (top, fr) => a(top, fr) + b(top, fr);
    } else if (fns.length === 3) {
      const [a, b, c] = fns;
      fn = (top, fr) => a(top, fr) + b(top, fr) + c(top, fr);
    } else {
      fn = (top, fr) => {
        let out = '';
        for (let k = 0; k < fns.length; k++) out += fns[k](top, fr);
        return out;
      };
    }
    // Whether this list reads per-render values other than loops at level >= `level`, decided by recompiling under
    // fresh analysis: done exactly by scanning the nodes.
    const dynOuter = (level) => readsOuter(nodes, frames, depth, level, new Set());
    return { fn, dyn, dynOuter };
  }

  // Whether `nodes` (under `frames`) read a DYNAMIC top name or a loop of level < `level`.
  function readsOuter(nodes, frames, depth, level, seen) {
    for (const n of nodes) {
      switch (n.kind) {
        case 'text':
          break;
        case 'var':
        case 'raw':
          if (pathReadsOuter(n.path, frames, level)) return true;
          break;
        case 'if':
          if (pathReadsOuter(n.path, frames, level)) return true;
          if (readsOuter(n.then, frames, depth, level, seen)) return true;
          if (n.else !== null && readsOuter(n.else, frames, depth, level, seen)) return true;
          break;
        case 'for':
          if (pathReadsOuter(n.path, frames, level)) return true;
          if (readsOuter(n.body, [...frames, n.name], depth, level, seen)) return true;
          break;
        case 'include': {
          if (!templates.has(n.name) || depth >= INCLUDE_DEPTH) break;
          const key = `${n.name}\0${depth + 1}\0${frames.join('\0')}`;
          if (seen.has(key)) break;
          seen.add(key);
          if (readsOuter(templates.get(n.name), frames, depth + 1, level, seen)) return true;
          break;
        }
      }
    }
    return false;
  }

  function pathReadsOuter(path, frames, level) {
    const first = path[0];
    for (let lv = frames.length - 1; lv >= 0; lv--) {
      if (first === 'loop' || frames[lv] === first) return lv < level;
    }
    return DYNAMIC.has(first);
  }

  return (name) => compileTemplate(name, [], 0);
}

// ---------------------------------------------------------------- the build

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => {
  const k = path.lastIndexOf('/');
  return k === -1 ? '' : path.slice(0, k);
};

export function run(input) {
  const report = [];
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // Sources and statics.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const c = f.content;
      sources.push({ path: f.path, text: c.includes('\r') ? c.replace(/\r\n?/g, '\n') : c });
    } else statics.push(f);
  }

  // Front matter.
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
    if (s.path.startsWith('tags/') || s.path.startsWith('page/')) {
      report.push(`refused ${s.path}: ${s.path.slice(0, s.path.indexOf('/'))}/ is the generator's own`);
      continue;
    }
    if (s.post && !hasOwn(s.data, 'date')) {
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

  // Permalinks.
  const taken = new Map();
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let t = taken.get(dir);
    if (t === undefined) {
      t = new Set(dir === '' ? ['posts', 'tags', 'page'] : []);
      taken.set(dir, t);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), t);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of sources) {
    const dir = dirOf(s.path);
    const link = (target) => {
      const c = target.charCodeAt(0);
      if (c === 47 || c === 35 || SCHEME.test(target)) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null) {
        const t = bySource.get(path);
        if (t !== undefined) return `${t.url}${frag}`;
        if (staticPaths.has(path)) return `${base}/${path}${frag}`;
      }
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // Tags.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push([name, slug]);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const [name, slug] of ownTags(p)) {
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) if (!s.post) s.tagRefs = ownTags(s).map(([name, slug]) => bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Layouts.
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
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const compile = makeCompiler(templates);
  const compiled = new Map();
  const render = (name, vars) => {
    if (!templates.has(name)) return null;
    let c = compiled.get(name);
    if (c === undefined) {
      c = compile(name);
      compiled.set(name, c);
    }
    return c.fn({ site, tags: allTags, recent, ...vars }, []);
  };

  const output = {};
  for (const s of sources) {
    const card = s.post ? cards.get(s) : cardOf(s);
    const page = {
      ...card,
      slug: s.slug,
      content: s.html,
      toc: s.toc,
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  if (templates.has('index')) {
    for (let k = 1; k <= pages; k++) {
      const html = render('index', {
        posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
        pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
      });
      output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
    }
  }
  if (templates.has('tag')) {
    for (const t of tags) {
      const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
      output[`tags/${t.slug}/index.html`] = html;
    }
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // Report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  lines.push(`built ${sources.length - posts.length} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
