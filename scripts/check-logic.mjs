// Assertions over the pure logic that v1.13 depends on.
//
// The repo had no committed test file before this — the assertion counts in
// the changelog were run ad hoc and thrown away, so nothing stopped a later
// edit from breaking them. This runs in `npm run lint`, uses `node:assert`
// and adds no dependency.
//
// Scope is deliberate: modules that are pure, and behaviour where being wrong
// is expensive. `reconcile.js` decides whether a user's local-only rows are
// ever pushed, and `localStore.js` decides whether a failed write is noticed.
// Both are the difference between keeping and losing somebody's work, and
// both are testable without a browser.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

// Teaches Node the directory imports Vite already understands, so the
// assertions run against the app's REAL modules rather than a copy. See
// scripts/resolve-dir-imports.mjs.
register('./resolve-dir-imports.mjs', import.meta.url);

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// ── localStorage stub ─────────────────────────────────────────────────────
//
// A real Map behind the DOM API, plus a switchable failure mode, because the
// entire point of localStore.js is what it does when the write fails — and
// that path is unreachable with a working store.

function makeStorage({ failWith = null, failUnlessFreed = 0 } = {}) {
  const map = new Map();
  let freed = 0;
  const store = {
    get length() { return map.size; },
    key: (i) => Array.from(map.keys())[i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      // `failUnlessFreed` models the real quota case: the write succeeds only
      // once enough recoverable bytes have been dropped. That is the retry
      // this module exists to perform, and asserting it needs a store that
      // can actually change its mind.
      if (failWith && freed < failUnlessFreed) {
        // The message must match the ERROR being simulated, not the scenario.
        // `isQuotaError` falls back to a message regex when the name and code
        // are unrecognised, so a SecurityError carrying the word "quota"
        // would be classified as a quota failure — and an earlier version of
        // this mock did exactly that, which made the non-quota assertion
        // below pass for the wrong reason.
        const e = new Error(`mock ${failWith}`);
        e.name = failWith;
        throw e;
      }
      map.set(k, String(v));
    },
    removeItem: (k) => {
      if (map.has(k)) freed += map.get(k).length;
      map.delete(k);
    },
  };
  return { store, map, freedBytes: () => freed };
}

// ── reconcile.js ──────────────────────────────────────────────────────────

const { findUnsynced } = await import('../src/lib/reconcile.js');

const COURSE = 'c0000000-0000-4000-8000-000000000001';
const emptyRemote = {
  subjects: [], exams: [], assignments: [], grades: [],
  sessions: [], plannedSessions: [], academicTerms: [],
  timetableEntries: [], commitments: [],
};

check('a local-only study session is queued — the v1.12 gap that lost five hours', () => {
  const out = findUnsynced(
    {
      courses: { [COURSE]: { id: COURSE, name: 'Physics' } },
      studySessions: [{ id: 's1', subjectId: COURSE, startedAt: '2026-09-01T10:00:00Z', durationMinutes: 300 }],
    },
    emptyRemote,
  );
  const session = out.find((o) => o.kind === 'log_session');
  assert.ok(session, 'expected a log_session item');
  assert.equal(session.payload.id, 's1');
  assert.equal(session.payload.durationMinutes, 300);
});

check('a session already on the server is not re-queued', () => {
  const out = findUnsynced(
    { courses: {}, studySessions: [{ id: 's1', startedAt: 'x', durationMinutes: 10 }] },
    { ...emptyRemote, sessions: [{ id: 's1' }] },
  );
  assert.equal(out.filter((o) => o.kind === 'log_session').length, 0);
});

check('a session with NO course is queued — an unassigned timer run is legitimate', () => {
  const out = findUnsynced(
    { courses: {}, studySessions: [{ id: 's1', subjectId: null, startedAt: 'x', durationMinutes: 25 }] },
    emptyRemote,
  );
  assert.equal(out.filter((o) => o.kind === 'log_session').length, 1);
});

check('a session whose course is MISSING everywhere is held back, not orphaned', () => {
  // The course is neither local nor remote, so pushing the session would
  // manufacture the FK failure this module exists to clear.
  const out = findUnsynced(
    { courses: {}, studySessions: [{ id: 's1', subjectId: 'ghost', startedAt: 'x', durationMinutes: 25 }] },
    emptyRemote,
  );
  assert.equal(out.filter((o) => o.kind === 'log_session').length, 0);
});

check('a session whose course is queued in the SAME batch goes too', () => {
  const out = findUnsynced(
    {
      courses: { [COURSE]: { id: COURSE, name: 'Physics' } },
      studySessions: [{ id: 's1', subjectId: COURSE, startedAt: 'x', durationMinutes: 25 }],
    },
    emptyRemote,
  );
  const kinds = out.map((o) => o.kind);
  assert.ok(kinds.includes('upsert_subject'));
  assert.ok(kinds.includes('log_session'));
  // Parent first: the outbox ranks by kind, but within a rank it drains
  // oldest-first, so emission order is what keeps the FK satisfied.
  assert.ok(kinds.indexOf('upsert_subject') < kinds.indexOf('log_session'));
});

check('a deleted session is never resurrected', () => {
  const out = findUnsynced(
    { courses: {}, studySessions: [{ id: 's1', deletedAt: '2026-09-01T00:00:00Z', startedAt: 'x', durationMinutes: 5 }] },
    emptyRemote,
  );
  assert.equal(out.filter((o) => o.kind === 'log_session').length, 0);
});

check('a planned block is queued as planned, never as a logged session', () => {
  // An intention is not evidence. If this ever emitted `log_session`, NCC's
  // Life Score would count a plan as work done.
  const out = findUnsynced(
    { courses: {}, plannedSessions: [{ id: 'p1', subjectId: null, startsAt: 'x', durationMinutes: 50 }] },
    emptyRemote,
  );
  assert.equal(out.filter((o) => o.kind === 'upsert_planned').length, 1);
  assert.equal(out.filter((o) => o.kind === 'log_session').length, 0);
});

check('a timetable entry waits for BOTH its term and its subject', () => {
  const withNeither = findUnsynced(
    { courses: {}, timetableEntries: [{ id: 't1', termId: 'ghost', subjectId: COURSE, weekday: 1 }] },
    emptyRemote,
  );
  assert.equal(withNeither.filter((o) => o.kind === 'upsert_timetable').length, 0);

  const withBoth = findUnsynced(
    {
      courses: { [COURSE]: { id: COURSE, name: 'Physics' } },
      academicTerms: [{ id: 'term1', level: 'jakso', name: 'J1' }],
      timetableEntries: [{ id: 't1', termId: 'term1', subjectId: COURSE, weekday: 1 }],
    },
    emptyRemote,
  );
  assert.equal(withBoth.filter((o) => o.kind === 'upsert_timetable').length, 1);
});

check('a commitment has no parent and is queued unconditionally', () => {
  const out = findUnsynced(
    { courses: {}, commitments: [{ id: 'cm1', title: 'Training', weekday: 2 }] },
    emptyRemote,
  );
  assert.equal(out.filter((o) => o.kind === 'upsert_commitment').length, 1);
});

check('a soft-deleted REMOTE row counts as present and is not re-pushed', () => {
  // The pull returns tombstones. Treating them as absent would resurrect
  // everything the user deleted on another device, on every single pull.
  const out = findUnsynced(
    { courses: {}, studySessions: [{ id: 's1', startedAt: 'x', durationMinutes: 5 }] },
    { ...emptyRemote, sessions: [{ id: 's1', deleted_at: '2026-09-01T00:00:00Z' }] },
  );
  assert.equal(out.filter((o) => o.kind === 'log_session').length, 0);
});

check('empty state produces no work', () => {
  assert.equal(findUnsynced({}, emptyRemote).length, 0);
  assert.equal(findUnsynced({}, {}).length, 0);
});

// ── localStore.js ─────────────────────────────────────────────────────────

const listeners = new Set();
globalThis.window = {
  dispatchEvent: () => true,
  addEventListener: (_n, fn) => listeners.add(fn),
  removeEventListener: (_n, fn) => listeners.delete(fn),
};

const good = makeStorage();
globalThis.localStorage = good.store;

const localStore = await import('../src/lib/localStore.js');

check('a successful write stores the value and reports healthy', () => {
  const r = localStore.writeJson('studydesk-v1', { a: 1 }, { critical: true });
  assert.equal(r.ok, true);
  assert.equal(good.map.get('studydesk-v1'), '{"a":1}');
  assert.equal(localStore.storageFailure(), null);
});

check('readJson round-trips, and returns the fallback for junk', () => {
  assert.deepEqual(localStore.readJson('studydesk-v1'), { a: 1 });
  good.map.set('broken', '{not json');
  assert.deepEqual(localStore.readJson('broken', 'FALLBACK'), 'FALLBACK');
  assert.deepEqual(localStore.readJson('absent', 'FALLBACK'), 'FALLBACK');
});

check('a quota failure is REPORTED, not swallowed — the whole point', () => {
  const bad = makeStorage({ failWith: 'QuotaExceededError', failUnlessFreed: Infinity });
  globalThis.localStorage = bad.store;
  const r = localStore.writeJson('studydesk-v1', { big: 'x' }, { critical: true });
  assert.equal(r.ok, false);
  const f = localStore.storageFailure();
  assert.ok(f, 'a critical failure must raise the health flag');
  assert.equal(f.reason, 'quota');
  assert.equal(f.key, 'studydesk-v1');
});

check('a failed write leaves the PREVIOUS value intact', () => {
  // A half-written key is worse than an old complete one. setItem leaves the
  // prior value in place on failure, and nothing here may undo that.
  const bad = makeStorage({ failWith: 'QuotaExceededError', failUnlessFreed: Infinity });
  bad.map.set('studydesk-v1', '{"kept":true}');
  globalThis.localStorage = bad.store;
  localStore.writeJson('studydesk-v1', { replaced: true }, { critical: true });
  assert.equal(bad.map.get('studydesk-v1'), '{"kept":true}');
});

check('a quota failure evicts recoverable caches and retries once', () => {
  const bad = makeStorage({ failWith: 'QuotaExceededError', failUnlessFreed: 5 });
  bad.map.set('studydesk.avatarCache', 'aaaaaaaaaa'); // 10 chars, enough
  globalThis.localStorage = bad.store;
  const r = localStore.writeJson('studydesk-v1', { a: 1 }, { critical: true });
  assert.equal(r.ok, true, 'the retry after eviction should succeed');
  assert.equal(bad.map.has('studydesk.avatarCache'), false, 'the cache should be gone');
  assert.equal(localStore.storageFailure(), null, 'a recovered write clears the flag');
});

check('user data is NEVER evicted to make room', () => {
  const bad = makeStorage({ failWith: 'QuotaExceededError', failUnlessFreed: Infinity });
  bad.map.set('studydesk-v1', '{"user":"data"}');
  bad.map.set('studydesk-outbox', '[{"queued":true}]');
  globalThis.localStorage = bad.store;
  localStore.writeJson('studydesk-notebook', { x: 1 }, { critical: true });
  assert.equal(bad.map.get('studydesk-v1'), '{"user":"data"}');
  assert.equal(bad.map.get('studydesk-outbox'), '[{"queued":true}]');
});

check('a non-quota failure does not thrash the caches', () => {
  // Private mode or a storage policy. Eviction cannot fix it, and dropping
  // caches for nothing would just cost the user their avatars.
  const bad = makeStorage({ failWith: 'SecurityError', failUnlessFreed: Infinity });
  bad.map.set('studydesk.avatarCache', 'cached');
  globalThis.localStorage = bad.store;
  const r = localStore.writeJson('studydesk-v1', { a: 1 }, { critical: true });
  assert.equal(r.ok, false);
  assert.equal(localStore.storageFailure().reason, 'blocked');
  assert.equal(bad.map.get('studydesk.avatarCache'), 'cached');
});

check('a NON-critical failure never raises the alarm', () => {
  globalThis.localStorage = makeStorage().store;
  localStore.writeJson('studydesk-v1', { ok: 1 }, { critical: true }); // clear the flag
  const bad = makeStorage({ failWith: 'QuotaExceededError', failUnlessFreed: Infinity });
  globalThis.localStorage = bad.store;
  const r = localStore.writeJson('studydesk-plan-sub', 'calendar');
  assert.equal(r.ok, false);
  assert.equal(localStore.storageFailure(), null, 'losing a UI preference is not an alarm');
});

check('a value that cannot be serialised reports as itself, not as quota', () => {
  globalThis.localStorage = makeStorage().store;
  const cyclic = {};
  cyclic.self = cyclic;
  const r = localStore.writeJson('studydesk-v1', cyclic, { critical: true });
  assert.equal(r.ok, false);
  assert.equal(localStore.storageFailure().reason, 'serialise');
});

console.log(`\n${passed} assertions passed.`);

// ── Notebook (v1.13 Item 1b) ──────────────────────────────────────────────
//
// The pure half of the notebook: the document model, the inline marks, the
// input rules, and the three §11 renderers. All total functions, all
// assertable without a DOM.
//
// The highlight-role assertions are the ones that matter most. §8 Trap 2
// calls a stored hex "the one decision here that is unrecoverable later" —
// it strands a light-mode yellow on a black page forever. These check that
// the format cannot express one.

const { BLOCK, parse, serialize, numbering, excerpt } = await import('../src/features/notebook/model.js');
const { renderInline, toggleMark, clearMarks, plainText, MARK } = await import('../src/features/notebook/inline.js');
const { matchBlockRule, applyBlockRule, undoBlockRule, enterBehaviour, indentBehaviour, backspaceAtStart } =
  await import('../src/features/notebook/inputRules.js');
const { parseMaths, flatten } = await import('../src/features/notebook/render/maths.js');
const { renderChem, parseEquation, tokeniseSpecies } = await import('../src/features/notebook/render/chem.js');
const { parseChain, parseAxes, parseTree, renderDiagram } = await import('../src/features/notebook/render/diagram.js');

// ── model ──

check('every block type round-trips through parse/serialize', () => {
  const src = [
    '# Heading one',
    '## Heading two',
    'plain paragraph',
    '- a bullet',
    '\t- a nested bullet',
    '1. first',
    '7. seventh',
    '[ ] unchecked',
    '[x] checked',
    '![abc123] IMG_2213',
  ].join('\n');
  assert.equal(serialize(parse(src)), src, 'round trip must be lossless');
});

check('an unparseable line is a paragraph containing the literal text', () => {
  // There is no such thing as an unopenable note — that is the point of
  // storing source rather than a block tree.
  const weird = '}}}{{{ <<< \\frac not closed';
  const blocks = parse(weird);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, BLOCK.P);
  assert.equal(blocks[0].text, weird);
});

check('`- [ ] x` is a checklist item, not a bullet starting with a bracket', () => {
  const [b] = parse('- [ ] buy paper');
  assert.equal(b.type, BLOCK.CHECK);
  assert.equal(b.checked, false);
  assert.equal(b.text, 'buy paper');
});

check('ordered-list numbering is computed, not stored', () => {
  // Deleting the second of five must renumber the rest rather than leave a
  // gap — which is the whole reason people expect a list type.
  const blocks = parse(['1. a', '1. b', '1. c'].join('\n'));
  const n = numbering(blocks);
  assert.deepEqual([n.get(0), n.get(1), n.get(2)], [1, 2, 3]);
});

check('an explicit start seeds the run — `7. ` starts at seven', () => {
  const blocks = parse(['7. a', '1. b'].join('\n'));
  const n = numbering(blocks);
  assert.deepEqual([n.get(0), n.get(1)], [7, 8]);
});

check('a non-list block breaks the run and restarts numbering', () => {
  const blocks = parse(['1. a', 'prose', '1. b'].join('\n'));
  const n = numbering(blocks);
  assert.deepEqual([n.get(0), n.get(2)], [1, 1]);
});

check('excerpt strips markers and marks for the tree row', () => {
  assert.equal(excerpt('## **Bold** ==marked== title'), 'Bold marked title');
});

// ── inline marks, and Trap 2 ──

check('a highlight stores its ROLE, never a colour', () => {
  const one = renderInline('a ==mark== b');
  const marked = one.find((t) => t.marks.includes(MARK.HL));
  assert.ok(marked);
  assert.equal(marked.role, 1);
  // The decisive assertion: nothing in a token carries a colour, and the
  // grammar has no production that could put one there.
  for (const tok of one) {
    assert.equal('color' in tok, false);
    assert.equal('hex' in tok, false);
  }
});

check('roles 2 and 3 parse and keep their identity', () => {
  assert.equal(renderInline('=2=unsure=2=').find((t) => t.role)?.role, 2);
  assert.equal(renderInline('=3=settled=3=').find((t) => t.role)?.role, 3);
});

check('no syntax exists that can store a hex as a highlight', () => {
  // A user typing a colour gets literal text, not a coloured highlight.
  const tokens = renderInline('==#EDD98A==');
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].text, '#EDD98A');
  assert.equal(tokens[0].role, 1, 'still role 1 — the hex is just content');
});

check('marks nest and both survive', () => {
  const t = renderInline('**bold *and italic* here**');
  const both = t.find((x) => x.marks.includes(MARK.BOLD) && x.marks.includes(MARK.ITALIC));
  assert.ok(both, 'expected a token carrying both marks');
  assert.equal(both.text, 'and italic');
});

check('`**` before `*`, and `=2=` before `==`', () => {
  assert.equal(renderInline('**x**')[0].marks[0], MARK.BOLD);
  assert.equal(renderInline('=2=x=2=')[0].role, 2);
});

check('an empty delimiter pair is literal text, not an empty mark', () => {
  // A maths note contains runs of asterisks; `****` is four characters.
  assert.equal(plainText('****'), '****');
});

check('toggling a mark twice restores the original exactly', () => {
  const src = 'hello world';
  const on = toggleMark(src, 0, 5, MARK.BOLD);
  assert.equal(on.source, '**hello** world');
  const off = toggleMark(on.source, on.start, on.end, MARK.BOLD);
  assert.equal(off.source, src, 'Ctrl+B twice must be a no-op');
});

check('toggling with nothing selected leaves the caret between the markers', () => {
  const r = toggleMark('ab', 1, 1, MARK.BOLD);
  assert.equal(r.source, 'a****b');
  assert.equal(r.start, 3);
  assert.equal(r.end, 3);
});

check('clear formatting strips character marks and leaves the text', () => {
  const r = clearMarks('**a** and ==b==', 0, 15);
  assert.equal(r.source, 'a and b');
});

// ── input rules ──

const P = (text) => ({ type: BLOCK.P, text, indent: 0, checked: false });

check('a rule fires only at the start of an empty block', () => {
  assert.ok(matchBlockRule(P('- '), 2), 'should fire at the start');
  assert.equal(matchBlockRule(P('There are 2 cases, 1. '), 22), null,
    'must NOT fire mid-sentence — this is the one that ruins prose');
});

check('every documented rule fires', () => {
  assert.equal(matchBlockRule(P('# '), 2).type, BLOCK.H1);
  assert.equal(matchBlockRule(P('## '), 3).type, BLOCK.H2);
  assert.equal(matchBlockRule(P('- '), 2).type, BLOCK.BULLET);
  assert.equal(matchBlockRule(P('* '), 2).type, BLOCK.BULLET);
  assert.equal(matchBlockRule(P('+ '), 2).type, BLOCK.BULLET);
  assert.equal(matchBlockRule(P('1. '), 3).type, BLOCK.NUMBER);
  assert.equal(matchBlockRule(P('[] '), 3).type, BLOCK.CHECK);
  assert.equal(matchBlockRule(P('[ ] '), 4).type, BLOCK.CHECK);
  assert.equal(matchBlockRule(P('[x] '), 4).checked, true, '`[x] ` starts CHECKED');
});

check('any digit starts an ordered list at that number', () => {
  assert.equal(matchBlockRule(P('3. '), 3).start, 3);
});

check('backspace after a rule restores the LITERAL characters', () => {
  // §5: "the escape hatch people reach for without being told; without it,
  // input rules feel like a trap."
  const m = matchBlockRule(P('- '), 2);
  const applied = applyBlockRule(P('- '), m);
  assert.equal(applied.type, BLOCK.BULLET);
  assert.equal(applied.text, '');
  const undone = undoBlockRule(applied, m.undo);
  assert.equal(undone.type, BLOCK.P);
  assert.equal(undone.text, '- ', 'the exact characters typed, restored');
});

check('Enter on an empty list item exits the list', () => {
  assert.equal(enterBehaviour({ type: BLOCK.BULLET, text: '', indent: 0 }).action, 'exit');
});

check('Enter on an empty NESTED item outdents first, then exits', () => {
  assert.equal(enterBehaviour({ type: BLOCK.BULLET, text: '', indent: 1 }).action, 'outdent');
});

check('Enter after a heading starts body text, never another heading', () => {
  assert.equal(enterBehaviour({ type: BLOCK.H1, text: 'Title', indent: 0 }).type, BLOCK.P);
});

check('a new checklist item is never pre-checked', () => {
  // Inheriting `checked` would silently mark work done that nobody did.
  assert.equal(enterBehaviour({ type: BLOCK.CHECK, text: 'x', indent: 0, checked: true }).checked, false);
});

check('nesting is capped at two levels', () => {
  const lvl0 = { type: BLOCK.BULLET, text: 'a', indent: 0 };
  assert.equal(indentBehaviour(lvl0, false).indent, 1);
  assert.equal(indentBehaviour({ ...lvl0, indent: 1 }, false), null, 'no third level');
  assert.equal(indentBehaviour(lvl0, true), null, 'cannot outdent past zero');
});

check('Tab does nothing in a paragraph', () => {
  assert.equal(indentBehaviour(P('text'), false), null);
});

check('backspace at start degrades in three steps, never one', () => {
  assert.equal(backspaceAtStart({ type: BLOCK.BULLET, text: 'a', indent: 1 }).action, 'outdent');
  assert.equal(backspaceAtStart({ type: BLOCK.BULLET, text: 'a', indent: 0 }).action, 'plain');
  assert.equal(backspaceAtStart(P('a')).action, 'merge');
});

// ── §11 maths ──

check('the maths subset is constrained AT THE PARSER', () => {
  // §11: "Constrain the subset at the parser, not in documentation, or it
  // grows into the out-of-scope list on its own."
  assert.equal(parseMaths('\\begin{align} x \\end{align}'), null, 'not in the grammar');
  assert.equal(parseMaths('\\includegraphics{x}'), null);
  assert.ok(parseMaths('\\alpha'), 'allow-listed commands do render');
});

check('superscripts, subscripts and braces', () => {
  assert.equal(flatten(parseMaths('x^2')), 'x²');
  assert.equal(flatten(parseMaths('x_i')), 'xᵢ');
  assert.equal(flatten(parseMaths('x^{n+1}')), 'xⁿ⁺¹');
});

check('a character with no Unicode superscript fails the span, losing nothing', () => {
  // Rendering `x^{α}` as `xα` would silently change what the note says.
  assert.equal(parseMaths('x^{\\alpha}'), null);
});

check('fractions stay structured so the renderer can draw a real rule', () => {
  const nodes = parseMaths('\\frac{a}{b}');
  assert.equal(nodes[0].t, 'frac');
  assert.equal(flatten(nodes), '(a/b)');
});

check('greek and operators render as Unicode', () => {
  assert.equal(flatten(parseMaths('\\alpha\\beta\\Delta')), 'αβΔ');
  assert.equal(flatten(parseMaths('\\int\\sum\\infty')), '∫∑∞');
});

// ── §11 chemistry ──

check('digits after an element subscript automatically', () => {
  const r = renderChem('H2O');
  assert.equal(r.kind, 'species');
  assert.equal(r.tokens.map((t) => t.text).join(''), 'H₂O');
});

check('a balanced equation is reported balanced', () => {
  const r = parseEquation('2H2 + O2 -> 2H2O');
  assert.equal(r.balanced, true);
  assert.deepEqual(r.tally.map((t) => [t.symbol, t.have, t.need]), [['H', 4, 4], ['O', 2, 2]]);
});

check('an unbalanced equation marks the offending column', () => {
  const r = parseEquation('H2 + O2 -> H2O');
  assert.equal(r.balanced, false);
  const o = r.tally.find((t) => t.symbol === 'O');
  assert.equal(o.ok, false);
  assert.equal(o.have, 2);
  assert.equal(o.need, 1);
});

check('group multipliers are counted — the case hand-tallying gets wrong', () => {
  const r = parseEquation('Ca(OH)2 + 2HCl -> CaCl2 + 2H2O');
  assert.equal(r.balanced, true);
  assert.equal(r.tally.find((t) => t.symbol === 'O').have, 2);
  assert.equal(r.tally.find((t) => t.symbol === 'H').have, 4);
});

check('two-letter symbols win over one-letter ones', () => {
  // `Co` is cobalt, not carbon + oxygen; `Cl` is chlorine, not carbon + l.
  assert.deepEqual(tokeniseSpecies('Co').map((t) => t.text), ['Co']);
  assert.deepEqual(tokeniseSpecies('CO').map((t) => t.text), ['C', 'O']);
});

check('state labels are never subscripted', () => {
  const r = renderChem('2H2O(l) -> 2H2(g) + O2(g)');
  assert.equal(r.balanced, true);
  const states = r.sides.left[0].tokens.filter((t) => t.kind === 'state');
  assert.equal(states[0].text, '(l)', 'roman, unchanged');
});

check('charge is tallied as its own row', () => {
  const r = parseEquation('Fe2+ + Ag+ -> Fe3+ + Ag');
  const q = r.tally.find((t) => t.isCharge);
  assert.ok(q, 'an ionic equation must tally charge');
  assert.equal(q.have, 3);
  assert.equal(q.need, 3);
});

check('equilibrium arrows are recognised', () => {
  assert.equal(parseEquation('N2 + 3H2 <-> 2NH3').arrow, '⇌');
  assert.equal(parseEquation('N2 + 3H2 -> 2NH3').arrow, '→');
});

check('ordinary prose is NOT chemistry', () => {
  // `In` is indium and also the word "in". Returning null is what stops the
  // renderer firing on a sentence.
  assert.equal(renderChem('just some words'), null);
  assert.equal(renderChem('In the beginning'), null);
});

// ── §11 diagrams ──

check('a chain needs at least two nodes', () => {
  assert.equal(parseChain('a -> b -> c').nodes.length, 3);
  assert.equal(parseChain('a ->'), null, 'one node is a word with an arrow, not a chain');
});

check('a trailing arrow closes the chain into a cycle', () => {
  assert.equal(parseChain('a -> b -> c ->').cycle, true);
  assert.equal(parseChain('a -> b -> c').cycle, false);
});

check('axes carry a SHAPE, never data', () => {
  const g = parseAxes('graph: x=t y=v, up-curve');
  assert.equal(g.shape, 'up-curve');
  assert.equal(g.x, 't');
  assert.equal(g.y, 'v');
  assert.ok(Array.isArray(g.points) && g.points.length > 1);
});

check('an unrecognised shape returns null rather than guessing', () => {
  // Guessing which curve somebody meant is worse than not drawing it.
  assert.equal(parseAxes('graph: x=t y=v, wiggly'), null);
});

check('plateau flattens the tail without being a seventh shape', () => {
  const plain = parseAxes('graph: s-curve');
  const flat = parseAxes('graph: s-curve, plateau');
  assert.equal(flat.plateau, true);
  const lastPlain = plain.points[plain.points.length - 1][1];
  const lastFlat = flat.points[flat.points.length - 1][1];
  assert.ok(lastFlat <= lastPlain, 'the tail should be flattened, not raised');
});

check('a tree is two levels, and deeper indentation joins the level above', () => {
  const tr = parseTree(['tree:', '  Mammals', '    Cats', '      Persian']);
  assert.equal(tr.roots.length, 1);
  assert.equal(tr.roots[0].label, 'Mammals');
  assert.equal(tr.roots[0].children.length, 2, 'the third level joins the second');
});

check('renderDiagram returns null for anything that is not one of the three', () => {
  assert.equal(renderDiagram('just words'), null);
  assert.ok(renderDiagram('a -> b'));
  assert.ok(renderDiagram('graph: peak'));
});

// ── Timetable: alternating weeks and attendance (v1.13 Tier 2) ────────────

const { weekParityOf, entryRunsOnParity, WEEK_ODD, WEEK_EVEN } =
  await import('../src/lib/timetable.js');
const {
  ATTENDANCE, summarise, summariseByCourse, nextStatus, indexAttendance, statusFor,
} = await import('../src/lib/attendance.js');

check('parity counts from the TERM start, and week 1 is odd', () => {
  // Term starts Monday 2026-08-31. Weeks run Mon-Sun.
  const start = '2026-08-31';
  assert.equal(weekParityOf('2026-08-31', start, 1), WEEK_ODD, 'day one is week A');
  assert.equal(weekParityOf('2026-09-06', start, 1), WEEK_ODD, 'still week 1 on the Sunday');
  assert.equal(weekParityOf('2026-09-07', start, 1), WEEK_EVEN, 'the next Monday flips');
  assert.equal(weekParityOf('2026-09-13', start, 1), WEEK_EVEN);
  assert.equal(weekParityOf('2026-09-14', start, 1), WEEK_ODD, 'and back again');
});

check('parity changes only at a week boundary, not mid-week', () => {
  // A term starting mid-week must still have its first Mon-Sun block as
  // week 1, or the parity would flip two days in.
  const start = '2026-09-02'; // a Wednesday
  const week1 = ['2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06'];
  for (const d of week1) assert.equal(weekParityOf(d, start, 1), WEEK_ODD, `${d} should be week A`);
  assert.equal(weekParityOf('2026-09-07', start, 1), WEEK_EVEN);
});

check('parity respects the user week start', () => {
  // Same dates, Sunday-first. The boundary moves with the week.
  const start = '2026-08-31';
  assert.equal(weekParityOf('2026-09-05', start, 0), WEEK_ODD, 'Saturday is still week 1');
  assert.equal(weekParityOf('2026-09-06', start, 0), WEEK_EVEN, 'Sunday starts week 2');
});

check('parity survives a DST transition', () => {
  // Europe/Helsinki moves on 2026-10-25. Computed from local midnights rather
  // than raw timestamp arithmetic, so the hour does not accumulate into a
  // day across a long term.
  const start = '2026-08-31';
  const before = weekParityOf('2026-10-19', start, 1);
  const after = weekParityOf('2026-10-26', start, 1);
  assert.notEqual(before, after, 'consecutive weeks must still alternate');
});

check('an unparseable date never hides a lesson', () => {
  // A lesson hidden because a date failed to parse is a lesson the student
  // misses. Null parity means "show it".
  assert.equal(weekParityOf('not-a-date', '2026-08-31', 1), null);
  assert.equal(entryRunsOnParity({ weekParity: WEEK_ODD }, null), true);
});

check('a null parity entry runs every week', () => {
  assert.equal(entryRunsOnParity({ weekParity: null }, WEEK_ODD), true);
  assert.equal(entryRunsOnParity({ weekParity: null }, WEEK_EVEN), true);
  assert.equal(entryRunsOnParity({}, WEEK_EVEN), true, 'a pre-v1.13 row has no field at all');
});

check('an odd-week entry runs on odd weeks only', () => {
  assert.equal(entryRunsOnParity({ weekParity: WEEK_ODD }, WEEK_ODD), true);
  assert.equal(entryRunsOnParity({ weekParity: WEEK_ODD }, WEEK_EVEN), false);
});

check('CANCELLED is not an absence — the whole subtlety of #31', () => {
  const rows = [
    { status: ATTENDANCE.PRESENT }, { status: ATTENDANCE.PRESENT },
    { status: ATTENDANCE.ABSENT },
    { status: ATTENDANCE.CANCELLED }, { status: ATTENDANCE.CANCELLED },
    { status: ATTENDANCE.RESCHEDULED },
  ];
  const s = summarise(rows);
  assert.equal(s.counted, 3, 'only present + absent are in the denominator');
  assert.equal(Math.round(s.percent), 67);
  assert.equal(s.cancelled, 2, 'still reported, just not counted');
});

check('nothing recorded is NULL percent, not zero', () => {
  // "0%" would be a false statement about a student who has marked nothing.
  assert.equal(summarise([]).percent, null);
  assert.equal(summarise([{ status: ATTENDANCE.CANCELLED }]).percent, null,
    'cancelled-only is still no data');
});

check('a perfect record is 100 and a blank one is 0', () => {
  assert.equal(summarise([{ status: ATTENDANCE.PRESENT }]).percent, 100);
  assert.equal(summarise([{ status: ATTENDANCE.ABSENT }]).percent, 0);
});

check('a soft-deleted row is not counted', () => {
  const s = summarise([{ status: ATTENDANCE.PRESENT }, { status: ATTENDANCE.ABSENT, deletedAt: 'x' }]);
  assert.equal(s.counted, 1);
  assert.equal(s.percent, 100);
});

check('an unknown status from a newer build is ignored, not counted', () => {
  const s = summarise([{ status: ATTENDANCE.PRESENT }, { status: 'excused' }]);
  assert.equal(s.counted, 1);
});

check('per-course summary sorts worst first, with no-data last', () => {
  const entries = new Map([
    ['e1', { id: 'e1', subjectId: 'physics' }],
    ['e2', { id: 'e2', subjectId: 'maths' }],
    ['e3', { id: 'e3', subjectId: 'art' }],
  ]);
  const rows = [
    { timetableEntryId: 'e1', status: ATTENDANCE.ABSENT },
    { timetableEntryId: 'e1', status: ATTENDANCE.PRESENT },
    { timetableEntryId: 'e2', status: ATTENDANCE.PRESENT },
    { timetableEntryId: 'e3', status: ATTENDANCE.CANCELLED },
  ];
  const out = summariseByCourse(rows, entries);
  assert.equal(out[0].courseId, 'physics', '50% comes first');
  assert.equal(out[1].courseId, 'maths', 'then 100%');
  assert.equal(out[2].courseId, 'art', 'no data sorts last, not as 0%');
  assert.equal(out[2].percent, null);
});

check('the status cycle returns to unmarked', () => {
  let s = null;
  const seen = [];
  for (let i = 0; i < 5; i++) { s = nextStatus(s); seen.push(s); }
  assert.deepEqual(seen, [
    ATTENDANCE.PRESENT, ATTENDANCE.ABSENT, ATTENDANCE.CANCELLED, ATTENDANCE.RESCHEDULED, null,
  ], 'present first — by far the most common answer, so the common case is one tap');
});

check('attendance is keyed by (entry, date), so one lesson is one fact', () => {
  const idx = indexAttendance([
    { timetableEntryId: 'e1', date: '2026-09-01', status: ATTENDANCE.PRESENT },
    { timetableEntryId: 'e1', date: '2026-09-08', status: ATTENDANCE.ABSENT },
    { timetableEntryId: 'e2', date: '2026-09-01', status: ATTENDANCE.ABSENT },
  ]);
  assert.equal(statusFor(idx, 'e1', '2026-09-01'), ATTENDANCE.PRESENT);
  assert.equal(statusFor(idx, 'e1', '2026-09-08'), ATTENDANCE.ABSENT);
  assert.equal(statusFor(idx, 'e2', '2026-09-01'), ATTENDANCE.ABSENT);
  assert.equal(statusFor(idx, 'e9', '2026-09-01'), null);
});

// ── Calendar feed (v1.13 Tier 3, #44) ─────────────────────────────────────
//
// The parser reads third-party documents fetched over a network, which is the
// least trustworthy input this app takes. Every assertion below is a shape a
// real feed actually produces.

const { parseIcs, parseIcsDate, toFeedItems, mergeFeedItems } =
  await import('../src/lib/icsParse.js');
const { normaliseFeedUrl, describeFeedUrl, isDue, POLL_INTERVAL_MS } =
  await import('../src/lib/calendarFeed.js');

const ICS = (body) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test//EN\r\n${body}\r\nEND:VCALENDAR\r\n`;

check('a minimal VEVENT parses', () => {
  const { events } = parseIcs(ICS('BEGIN:VEVENT\r\nUID:abc\r\nSUMMARY:Essay\r\nDTSTART;VALUE=DATE:20260915\r\nEND:VEVENT'));
  assert.equal(events.length, 1);
  assert.equal(events[0].uid, 'abc');
  assert.equal(events[0].summary, 'Essay');
  assert.equal(events[0].start.iso, '2026-09-15');
  assert.equal(events[0].start.allDay, true);
});

check('folded lines are unfolded BEFORE parsing', () => {
  // Servers fold aggressively. Without unfolding first, a long description
  // arrives in pieces and every field after it on that line is lost.
  const folded = 'BEGIN:VEVENT\r\nUID:x\r\nDESCRIPTION:This is a very long descrip\r\n tion that the server folded\r\nDTSTART;VALUE=DATE:20260101\r\nEND:VEVENT';
  const { events } = parseIcs(ICS(folded));
  assert.equal(events.length, 1);
  assert.equal(events[0].description, 'This is a very long description that the server folded');
});

check('all three line endings are handled', () => {
  const body = 'BEGIN:VEVENT\nUID:lf\nSUMMARY:LF only\nDTSTART;VALUE=DATE:20260101\nEND:VEVENT';
  const { events } = parseIcs(`BEGIN:VCALENDAR\n${body}\nEND:VCALENDAR`);
  assert.equal(events.length, 1, 'an LF-only file must not read as one line');
});

check('TEXT escapes are reversed, in the right order', () => {
  const { events } = parseIcs(ICS(
    'BEGIN:VEVENT\r\nUID:e\r\nSUMMARY:Maths\\, Physics\; and a \\\\ backslash\\nsecond line\r\nDTSTART;VALUE=DATE:20260101\r\nEND:VEVENT',
  ));
  assert.equal(events[0].summary, 'Maths, Physics; and a \\ backslash\nsecond line');
});

check('a colon inside a value does not split the line', () => {
  const { events } = parseIcs(ICS('BEGIN:VEVENT\r\nUID:u\r\nURL:https://example.org/a:b\r\nDTSTART;VALUE=DATE:20260101\r\nEND:VEVENT'));
  assert.equal(events[0].url, 'https://example.org/a:b');
});

check('a VALARM inside a VEVENT does not steal the summary', () => {
  // Without the nesting guard, the alarm's SUMMARY overwrites the event's and
  // every item in the feed comes back named "Reminder".
  const { events } = parseIcs(ICS(
    'BEGIN:VEVENT\r\nUID:a\r\nSUMMARY:Real title\r\nDTSTART;VALUE=DATE:20260101\r\n' +
    'BEGIN:VALARM\r\nACTION:DISPLAY\r\nSUMMARY:Reminder\r\nEND:VALARM\r\nEND:VEVENT',
  ));
  assert.equal(events[0].summary, 'Real title');
});

check('a VTIMEZONE block is skipped entirely', () => {
  const { events } = parseIcs(ICS(
    'BEGIN:VTIMEZONE\r\nTZID:Europe/Helsinki\r\nBEGIN:STANDARD\r\nDTSTART:19701025T040000\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\n' +
    'BEGIN:VEVENT\r\nUID:v\r\nSUMMARY:After the timezone\r\nDTSTART;VALUE=DATE:20260101\r\nEND:VEVENT',
  ));
  assert.equal(events.length, 1, 'the VTIMEZONE DTSTART must not become an event');
  assert.equal(events[0].summary, 'After the timezone');
});

check('one malformed event does not cost the rest of the feed', () => {
  const { events, errors } = parseIcs(ICS(
    'BEGIN:VEVENT\r\nSUMMARY:No uid and no date\r\nEND:VEVENT\r\n' +
    'BEGIN:VEVENT\r\nUID:good\r\nSUMMARY:Fine\r\nDTSTART;VALUE=DATE:20260101\r\nEND:VEVENT',
  ));
  assert.equal(events.length, 1);
  assert.equal(errors, 1);
});

check('DUE stands in for DTSTART when there is no DTSTART', () => {
  // Many LMS feeds publish a deadline this way; without it those feeds import
  // nothing at all.
  const { events } = parseIcs(ICS('BEGIN:VEVENT\r\nUID:d\r\nSUMMARY:Homework\r\nDUE;VALUE=DATE:20261111\r\nEND:VEVENT'));
  assert.equal(events[0].start.iso, '2026-11-11');
});

check('the three date forms are distinguished', () => {
  assert.deepEqual(parseIcsDate('20260915'), { iso: '2026-09-15', allDay: true });
  const floating = parseIcsDate('20260915T140000');
  assert.equal(floating.iso, '2026-09-15');
  assert.equal(floating.allDay, false);
  assert.equal(floating.time, '14:00');
  // A UTC instant converts to the READER's local day, which is what makes a
  // 23:59 UTC deadline land correctly for a reader east of Greenwich.
  const utc = parseIcsDate('20260915T120000Z');
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(utc.iso));
  assert.equal(utc.allDay, false);
});

check('garbage dates return null rather than a wrong day', () => {
  assert.equal(parseIcsDate('nonsense'), null);
  assert.equal(parseIcsDate(''), null);
});

check('a CANCELLED event is not imported', () => {
  // Keeping it would put a cancelled exam on a student's calendar.
  const items = toFeedItems([
    { uid: 'a', summary: 'Gone', status: 'CANCELLED', start: { iso: '2026-01-01' } },
    { uid: 'b', summary: 'Live', start: { iso: '2026-01-02' } },
  ], 'f1');
  assert.equal(items.length, 1);
  assert.equal(items[0].uid, 'b');
});

check('imported items claim NOTHING the format does not carry', () => {
  // "Due dates arrive on their own", not "the LMS mirrored". No type, no
  // points, no submission status — inferring any of them is how the feature
  // starts being read as a full mirror.
  const [item] = toFeedItems([{ uid: 'a', summary: 'Quiz 3', start: { iso: '2026-01-01' } }], 'f1');
  assert.equal('points' in item, false);
  assert.equal('submitted' in item, false);
  assert.equal(item.title, 'Quiz 3', 'the title is verbatim, not parsed for a type');
});

check('merge dedupes by UID — the reason re-polling does not duplicate', () => {
  const first = mergeFeedItems([], [
    { uid: 'a', title: 'Essay', dueDate: '2026-01-01' },
    { uid: 'b', title: 'Lab', dueDate: '2026-01-02' },
  ]);
  assert.equal(first.items.length, 2);
  assert.equal(first.added, 2);

  const again = mergeFeedItems(first.items, [
    { uid: 'a', title: 'Essay', dueDate: '2026-01-01' },
    { uid: 'b', title: 'Lab', dueDate: '2026-01-02' },
  ]);
  assert.equal(again.items.length, 2, 'a second identical poll adds nothing');
  assert.equal(again.added, 0);
  assert.equal(again.updated, 0);
});

check('a changed due date counts as an update, not a duplicate', () => {
  const before = [{ uid: 'a', title: 'Essay', dueDate: '2026-01-01' }];
  const after = mergeFeedItems(before, [{ uid: 'a', title: 'Essay', dueDate: '2026-01-08' }]);
  assert.equal(after.items.length, 1);
  assert.equal(after.updated, 1);
  assert.equal(after.items[0].dueDate, '2026-01-08');
});

check('a UID that vanishes from the feed is reported removed', () => {
  const before = [{ uid: 'a', title: 'A', dueDate: '2026-01-01' }, { uid: 'b', title: 'B', dueDate: '2026-01-02' }];
  const after = mergeFeedItems(before, [{ uid: 'a', title: 'A', dueDate: '2026-01-01' }]);
  assert.equal(after.removed, 1);
  assert.equal(after.items.length, 1);
});

check('feed URLs are normalised, and only http(s) survives', () => {
  assert.ok(normaliseFeedUrl('https://example.org/f.ics'));
  assert.ok(normaliseFeedUrl('  http://example.org/f.ics  '), 'whitespace is trimmed');
  // webcal: is what the "Subscribe" button on most calendar pages copies.
  assert.ok(normaliseFeedUrl('webcal://example.org/f.ics').startsWith('https://'));
  // A field that later gets fetched must never accept these.
  assert.equal(normaliseFeedUrl('javascript:alert(1)'), null);
  assert.equal(normaliseFeedUrl('file:///etc/passwd'), null);
  assert.equal(normaliseFeedUrl('data:text/calendar,BEGIN'), null);
  assert.equal(normaliseFeedUrl(''), null);
  assert.equal(normaliseFeedUrl('not a url'), null);
});

check('only the HOST is ever shown — the path is the capability', () => {
  assert.equal(describeFeedUrl('https://school.example.org/feeds/u/9/secret-token.ics'), 'school.example.org');
});

check('poll cadence: due when never fetched, and after the interval', () => {
  const now = Date.now();
  assert.equal(isDue({ lastFetchedAt: null }, now), true);
  assert.equal(isDue({ lastFetchedAt: 'garbage' }, now), true, 'an unreadable timestamp re-fetches');
  assert.equal(isDue({ lastFetchedAt: new Date(now - 1000).toISOString() }, now), false);
  assert.equal(isDue({ lastFetchedAt: new Date(now - POLL_INTERVAL_MS - 1000).toISOString() }, now), true);
});

// ── outbox.js — the queue must not grow without bound ─────────────────────
//
// v1.13 review, blocker 1. `reconcileUnsynced` runs on every pull, and pull is
// also the realtime handler, so a row that can never push was re-enqueued as a
// brand new item forever — unbounded growth in the same origin quota as the
// state blob, which is the durability failure this release exists to fix.
//
// These lock the coalescing that bounds it. `drain` is never called here: the
// assertions are about what `enqueue` puts in storage, and drain needs network.

// Node 22 exposes `navigator` as a getter-only global, so it is redefined
// rather than assigned. Offline keeps `enqueue`'s fire-and-forget drain a
// no-op — these assertions are about what lands in storage, not the network.
Object.defineProperty(globalThis, 'navigator', {
  value: { onLine: false }, configurable: true, writable: true,
});
const obStore = makeStorage();
globalThis.localStorage = obStore.store;

const outbox = await import('../src/lib/outbox.js');

const queued = () => JSON.parse(obStore.map.get('studydesk-outbox') || '[]');

check('re-enqueueing the same row coalesces instead of appending', () => {
  outbox.clear();
  for (let i = 0; i < 50; i++) {
    outbox.enqueue('upsert_note', { id: 'note-1', content: `draft ${i}` });
  }
  const items = queued();
  assert.equal(items.length, 1, '50 pulls must leave one item, not fifty');
  assert.equal(items[0].payload.content, 'draft 49', 'the newest snapshot wins');
});

check('different rows and different kinds stay separate items', () => {
  outbox.clear();
  outbox.enqueue('upsert_note', { id: 'a', content: 'x' });
  outbox.enqueue('upsert_note', { id: 'b', content: 'y' });
  // Same row, different fact: an edit and a tombstone are not interchangeable
  // and must both survive, in order.
  outbox.enqueue('delete_note', { id: 'a' });
  assert.equal(queued().length, 3);
});

check('an identical payload does not reset a quarantined row\'s budget', () => {
  outbox.clear();
  outbox.enqueue('upsert_attendance', { id: 'att-1', status: 'present' });
  // Simulate the row having burned its attempts, as a 42P10 would have done.
  const items = queued();
  items[0].attempts = 5;
  items[0].quarantined = true;
  obStore.map.set('studydesk-outbox', JSON.stringify(items));

  // Reconcile re-manufacturing the SAME snapshot. This is the case the
  // coalescing exists for: it must not spawn a duplicate and must not hand
  // work that already failed a fresh budget.
  outbox.enqueue('upsert_attendance', { id: 'att-1', status: 'present' });
  const after = queued();
  assert.equal(after.length, 1, 'a quarantined row must not spawn a duplicate');
  assert.equal(after[0].quarantined, true, 're-pushing identical work must not revive it');
  assert.equal(after[0].attempts, 5, 'the failure budget is not reset behind the user');
});

check('a NEW payload on a quarantined row does not silently vanish', () => {
  // v1.13 review, blocker B. Coalescing preserved `quarantined`, and `drain`
  // skips quarantined items, so once a row burned its attempts on a transient
  // failure every later edit to it disappeared into the dead item — forever,
  // with no error and no new item. On notes, that is the app's most precious
  // data going nowhere.
  outbox.clear();
  outbox.enqueue('upsert_note', { id: 'note-1', content: 'five hours of work' });
  const items = queued();
  items[0].attempts = 5;
  items[0].quarantined = true;
  items[0].lastError = 'NetworkError: failed to fetch';
  obStore.map.set('studydesk-outbox', JSON.stringify(items));

  // The user keeps typing. Their new words have never had a chance to reach
  // the server, so they get one.
  outbox.enqueue('upsert_note', { id: 'note-1', content: 'five hours of work, plus more' });
  const after = queued();
  assert.equal(after.length, 1, 'still bounded — one item per row');
  assert.equal(after[0].payload.content, 'five hours of work, plus more');
  assert.equal(after[0].quarantined, false, 'a genuinely new edit revives the row');
  assert.equal(after[0].attempts, 0, 'and gets its own attempt budget');
  assert.equal(after[0].lastError, null, 'the superseded error is cleared');
});

check('key order does not make identical work look like a new edit', () => {
  // `upsert_note` payloads are built in two places — App.jsx's debounced editor
  // timer and reconcile.js's offline repair pass. If their key orders ever
  // diverged, a naive serialisation compare would read reconcile's identical
  // snapshot as a fresh user edit and hand it a new attempt budget every pass,
  // quietly reintroducing the unbounded retry the coalescing exists to stop.
  outbox.clear();
  outbox.enqueue('upsert_note', { id: 'n1', title: 'T', content: 'body', courseId: 'c1' });
  const items = queued();
  items[0].attempts = 5;
  items[0].quarantined = true;
  obStore.map.set('studydesk-outbox', JSON.stringify(items));

  // Same fields, same values, written in a different order.
  outbox.enqueue('upsert_note', { courseId: 'c1', content: 'body', id: 'n1', title: 'T' });
  const after = queued();
  assert.equal(after.length, 1);
  assert.equal(after[0].quarantined, true, 'reordered but identical work is not a new edit');
  assert.equal(after[0].attempts, 5, 'so it must not be handed a fresh budget');
});

check('upsert -> delete -> upsert keeps the user\'s final state', () => {
  // v1.13 review, blocker C. `kind` is part of the coalescing identity, so
  // upserts and deletes never coalesce together — and taking the FIRST match
  // moved the newer upsert behind the older delete. Three offline taps on one
  // lesson (present -> ... -> null -> present) ended with the row DELETED.
  outbox.clear();
  outbox.enqueue('upsert_attendance', { id: 'att-1', status: 'present' });
  outbox.enqueue('delete_attendance', { id: 'att-1' });
  outbox.enqueue('upsert_attendance', { id: 'att-1', status: 'present' });

  const after = queued();
  assert.equal(after.length, 3, 'the newer upsert must not fold into the older one');
  assert.equal(after[after.length - 1].kind, 'upsert_attendance',
    'the last thing to drain must be the upsert, or the lesson ends up deleted');
  assert.equal(after[1].kind, 'delete_attendance', 'the delete keeps its place in the sequence');
});

check('a repeated upsert after a delete still coalesces, staying bounded', () => {
  // The blocker-C fix must not give back the unbounded queue: once the newest
  // item for a row is an upsert again, further upserts fold into it.
  outbox.clear();
  outbox.enqueue('upsert_note', { id: 'n1', content: 'a' });
  outbox.enqueue('delete_note', { id: 'n1' });
  for (let i = 0; i < 20; i++) outbox.enqueue('upsert_note', { id: 'n1', content: `b${i}` });

  const after = queued();
  assert.equal(after.length, 3, 'upsert, delete, and ONE coalesced upsert');
  assert.equal(after[2].payload.content, 'b19', 'carrying the newest snapshot');
});

check('a parent always drains before its child, whatever order they enqueue in', () => {
  // v1.13 review. `upsert_attendance` -> `timetable_entries` and
  // `upsert_note_attachment` -> `notebook_entries` were both rank 1, sitting at
  // the same rank as their own parents and relying on FIFO. Reconcile emits
  // parents and children in one pass, so "they happen to be in the right order"
  // is exactly the argument #38 disproved.
  outbox.clear();
  // Deliberately worst-case: every child enqueued before its parent.
  outbox.enqueue('upsert_note_attachment', { id: 'att-1', noteId: 'n1' });
  outbox.enqueue('upsert_attendance', { id: 'a-1', timetableEntryId: 't1' });
  outbox.enqueue('upsert_note', { id: 'n1', courseId: 'c1', content: 'x' });
  outbox.enqueue('upsert_timetable', { id: 't1', subjectId: 'c1' });
  outbox.enqueue('upsert_subject', { id: 'c1', name: 'Maths' });

  const order = outbox.__drainOrderForTest(queued()).map((i) => i.kind);
  const pos = (k) => order.indexOf(k);
  assert.ok(pos('upsert_subject') < pos('upsert_timetable'),
    'a timetable entry carries subject_id — its subject must exist first');
  assert.ok(pos('upsert_subject') < pos('upsert_note'),
    'a note carries course_id');
  assert.ok(pos('upsert_timetable') < pos('upsert_attendance'),
    'attendance carries timetable_entry_id, and the FK cascades');
  assert.ok(pos('upsert_note') < pos('upsert_note_attachment'),
    'an attachment carries note_id');
});

check('payloads with no row id still enqueue, one per call', () => {
  outbox.clear();
  outbox.enqueue('record_app_open', { app: 'studydesk', date: '2026-09-04' });
  outbox.enqueue('record_app_open', { app: 'studydesk', date: '2026-09-05' });
  assert.equal(queued().length, 2, 'kinds without an id keep the old append behaviour');
});

// ── notebook/model.js — a paste must survive every exit from the editor ───
//
// v1.13 review, blocker E. The textarea holds ONE block, so a newline can only
// arrive by paste. The previous round split at the commit boundary, which
// covered blur/Escape/arrow-out — but six other exits still reduced the draft
// with `parse(draft)[0]` and wrote the truncation back to the note:
//
//   Enter · Tab · Backspace-at-start · block shortcut · toggleCheck ·
//   the format bar's block button
//
// The last is the worst: on Android the format bar is the primary way to set a
// block type, so paste-then-format silently destroyed everything after line
// one.
//
// The fix normalises in `onInput`, so `draft` never holds a multi-line value
// for any of those six to see. That makes two things worth locking: the splice
// itself is correct, and `onInput` actually performs it.

const { parse: nbParse, serialize: nbSerialize, spliceDraft } =
  await import('../src/features/notebook/model.js');

const PASTE = 'Lecture 3\nFirst point\nSecond point\nThird point';

check('a multi-line paste becomes every one of its lines, not just the first', () => {
  const blocks = nbParse('existing');
  const out = spliceDraft(blocks, 0, PASTE);
  assert.ok(out, 'a multi-line draft must produce a splice');
  assert.equal(out.blocks.length, 4, 'four pasted lines must become four blocks');
  assert.deepEqual(
    out.blocks.map((b) => b.text),
    ['Lecture 3', 'First point', 'Second point', 'Third point'],
  );
  assert.equal(out.focus, 3, 'the caret lands at the end of what was pasted');
});

check('a single-line draft is left alone for the ordinary path', () => {
  assert.equal(spliceDraft(nbParse('one'), 0, 'just one line'), null);
  assert.equal(spliceDraft(nbParse('one'), 0, ''), null);
});

check('pasting into the middle keeps the blocks on either side', () => {
  const blocks = nbParse('before\ntarget\nafter');
  const out = spliceDraft(blocks, 1, PASTE);
  assert.deepEqual(
    out.blocks.map((b) => b.text),
    ['before', 'Lecture 3', 'First point', 'Second point', 'Third point', 'after'],
  );
  assert.equal(out.focus, 4, 'the caret is on the last pasted line, not on `after`');
});

check('block ids stay positional after a splice', () => {
  // Every handler in the editor writes with `next[focus] = { ...cur, id: focus }`,
  // so an id that does not match its index sends the next edit to the wrong
  // block.
  const out = spliceDraft(nbParse('a\nb\nc'), 1, PASTE);
  assert.deepEqual(out.blocks.map((b) => b.id), out.blocks.map((_, i) => i));
});

check('markdown markers in a paste are parsed, not left as literal text', () => {
  const out = spliceDraft(nbParse(''), 0, '# Heading\n- one\n- two');
  assert.equal(out.blocks.length, 3);
  assert.notEqual(out.blocks[0].type, out.blocks[1].type, 'a heading is not a bullet');
  // Round-trip: what the note stores must re-parse to the same thing.
  assert.deepEqual(
    nbParse(nbSerialize(out.blocks)).map((b) => b.text),
    out.blocks.map((b) => b.text),
  );
});

check('NoteEditor normalises multi-line input before any exit can truncate it', () => {
  // A source check, in the spirit of check-ime.mjs. The six truncating exits
  // are inside a React component and cannot be exercised from here, so what is
  // locked instead is the invariant that makes all six safe: `onInput` splices
  // a multi-line draft immediately, and `commitDraft` keeps a backstop.
  const src = readFileSync(
    new URL('../src/features/notebook/NoteEditor.jsx', import.meta.url), 'utf8',
  );

  const onInput = src.slice(src.indexOf('const onInput = useCallback'));
  const onInputBody = onInput.slice(0, onInput.indexOf('}, ['));
  assert.ok(
    /spliceDraft\(/.test(onInputBody),
    'onInput must call spliceDraft — it is the only place every text-insertion '
    + 'route arrives, including Android IME clipboard insertion, which fires no '
    + 'paste event. Without it, draft can hold a multi-line value and the six '
    + 'parse(draft)[0] exits truncate the note.',
  );
  assert.ok(
    /setDraft\(text\)/.test(onInputBody.slice(onInputBody.indexOf('spliceDraft('))),
    'the single-line path must still set the draft',
  );

  const commitDraft = src.slice(src.indexOf('const commitDraft = useCallback'));
  assert.ok(
    /spliceDraft\(/.test(commitDraft.slice(0, commitDraft.indexOf('}, ['))),
    'commitDraft must keep its backstop splice for any commit that did not '
    + 'pass through onInput',
  );
});

// ── icsParse.js — repeating events are counted, never silently dropped ────

check('an RRULE event is imported once and reported as repeating', () => {
  const ics = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:lecture-1',
    'SUMMARY:Analysis I',
    'DTSTART:20260907T100000Z',
    'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=12',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:essay-1',
    'SUMMARY:Essay due',
    'DTSTART:20260918T235900Z',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const { events } = parseIcs(ics);
  const items = toFeedItems(events, 'feed-1');
  assert.equal(items.length, 2, 'the first occurrence is still imported');
  assert.equal(items.repeating, 1, 'and the term of lectures behind it is reported');
  assert.equal(items[0].repeats, true);
  assert.equal(items[1].repeats, false, 'a one-off is not marked repeating');
});

check('the repeating count does not disturb the items array', () => {
  const { events } = parseIcs(
    'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART:20260907\r\nEND:VEVENT\r\nEND:VCALENDAR',
  );
  const items = toFeedItems(events, 'f');
  // Non-enumerable on purpose: every existing caller spreads, maps or measures
  // this array and must be entirely unaffected by the new field.
  assert.deepEqual(Object.keys(items), ['0']);
  assert.equal([...items].length, 1);
  assert.equal(JSON.parse(JSON.stringify(items)).length, 1);
});

// ── passwordRecovery.js — which URLs are a recovery (#52) ─────────────────
//
// This one predicate decides whether a link that comes back from an email
// opens "choose a new password" or opens the app. Both ways of getting it
// wrong are silent and serious:
//
//   * too narrow — a real recovery link signs the user in with the password
//     they could not remember still in place, which is issue #52 all over
//     again, one step further along.
//   * too broad — an ordinary Google sign-in is mistaken for a recovery and
//     every signed-in user is asked to set a new password to get past the
//     gate.
//
// It is a regex over a URL rather than two URL parses because the marker is
// the same token whether Supabase puts it in the query (PKCE) or the fragment
// (implicit), and which of those arrives is a project setting, not something
// this app chooses.
const { looksLikeRecovery } = await import('../src/lib/passwordRecovery.js');

check('a recovery link is recognised in the query and in the fragment', () => {
  assert.equal(looksLikeRecovery('https://app.example/?code=abc&type=recovery'), true);
  assert.equal(looksLikeRecovery('https://app.example/#access_token=x&type=recovery'), true);
  // Native deep link — same question, different scheme.
  assert.equal(looksLikeRecovery('com.studydesk.app://login-callback?code=abc&type=recovery'), true);
  // Not necessarily last in the string.
  assert.equal(looksLikeRecovery('https://app.example/?type=recovery&code=abc'), true);
});

check('an ordinary sign-in callback is NOT a recovery', () => {
  assert.equal(looksLikeRecovery('https://app.example/?code=abc'), false);
  assert.equal(looksLikeRecovery('com.studydesk.app://login-callback?code=abc'), false);
  assert.equal(looksLikeRecovery('https://app.example/#access_token=x&type=signup'), false);
  assert.equal(looksLikeRecovery('https://app.example/'), false);
  assert.equal(looksLikeRecovery(''), false);
  assert.equal(looksLikeRecovery(undefined), false);
});

check('a value that merely CONTAINS the word is not a recovery', () => {
  // The defect this pins: a substring test on the whole URL would call both of
  // these a recovery, and the second is a perfectly ordinary sign-in return to
  // a page whose path happens to say so.
  assert.equal(looksLikeRecovery('https://app.example/?next=type=recovery'), false);
  assert.equal(looksLikeRecovery('https://app.example/account/type=recovery?code=abc'), false);
  assert.equal(looksLikeRecovery('https://app.example/?type=recovery-plan&code=abc'), false);
});

// ── studyDay.js — which day a session belongs to (#54) ────────────────────
//
// Two defects, one module. The first was that three surfaces answered this
// question and two of them answered it in UTC:
//
//     `startedAt.slice(0, 10)` is the UTC date
//
// so west of Greenwich every evening session was filed a day late and east of
// it every early-morning one a day early — while the streak, which was local
// and correct, disagreed with both. The `TZ` switching below is what makes
// that testable on a CI runner that is itself UTC: in UTC the two
// implementations are indistinguishable, which is exactly why the bug lived
// as long as it did.
//
// The second is the boundary itself. A night owl's 01:00 session ends one
// night rather than starting a day, and splitting it across two calendar days
// breaks a streak they kept.
const studyDay = await import('../src/lib/studyDay.js');

function inTimezone(tz, fn) {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  try { return fn(); } finally { process.env.TZ = previous; }
}

check('a study day is the LOCAL date, not the UTC one', () => {
  inTimezone('America/Los_Angeles', () => {
    // 21:00 on the 10th in UTC-7 is 04:00 on the 11th in UTC.
    const evening = new Date(2026, 8, 10, 21, 0, 0);
    assert.equal(evening.toISOString().slice(0, 10), '2026-09-11', 'precondition: the UTC slice really is the next day');
    assert.equal(studyDay.studyDayKey(evening), '2026-09-10');
  });
  inTimezone('Asia/Tokyo', () => {
    // 00:30 on the 11th in UTC+9 is 15:30 on the 10th in UTC.
    const smallHours = new Date(2026, 8, 11, 0, 30, 0);
    assert.equal(smallHours.toISOString().slice(0, 10), '2026-09-10', 'precondition: the UTC slice really is the previous day');
    assert.equal(studyDay.studyDayKey(smallHours), '2026-09-11');
  });
});

check('the day boundary moves late-night study to the night before', () => {
  const lateNight = new Date(2026, 8, 11, 1, 30, 0);   // 01:30
  const morning = new Date(2026, 8, 11, 7, 0, 0);      // 07:00
  // Default: the calendar answer, so no existing user's numbers move.
  assert.equal(studyDay.studyDayKey(lateNight), '2026-09-11');
  assert.equal(studyDay.studyDayKey(lateNight, 0), '2026-09-11');
  // With a 4am boundary the small hours belong to the night before…
  assert.equal(studyDay.studyDayKey(lateNight, 4), '2026-09-10');
  // …and the morning after does not.
  assert.equal(studyDay.studyDayKey(morning, 4), '2026-09-11');
  // Exactly on the boundary is the new day: the rule is "before this hour".
  assert.equal(studyDay.studyDayKey(new Date(2026, 8, 11, 4, 0, 0), 4), '2026-09-11');
  assert.equal(studyDay.studyDayKey(new Date(2026, 8, 11, 3, 59, 0), 4), '2026-09-10');
});

check('an out-of-range or junk boundary cannot relabel the whole day', () => {
  const afternoon = new Date(2026, 8, 11, 15, 0, 0);
  // 23 would make every daytime session count for yesterday. Clamped to 6.
  assert.equal(studyDay.studyDayKey(afternoon, 23), '2026-09-11');
  assert.equal(studyDay.studyDayKey(afternoon, -5), '2026-09-11');
  assert.equal(studyDay.studyDayKey(afternoon, NaN), '2026-09-11');
  assert.equal(studyDay.studyDayKey(afternoon, undefined), '2026-09-11');
});

check('an unusable date is reported as such, not as today', () => {
  // The grouping falls back to an "unknown" bucket on null. Returning a key
  // here would file a broken row under whatever day the app is having.
  assert.equal(studyDay.studyDayKey(null), null);
  assert.equal(studyDay.studyDayKey(''), null);
  assert.equal(studyDay.studyDayKey('not a date'), null);
});

check('walking back a day survives a DST transition', () => {
  inTimezone('America/Los_Angeles', () => {
    // 2026-11-01 is the US fall-back: that local day is 25 hours long, so
    // subtracting 86400000ms lands back on the same date and a streak would
    // count one day twice. shiftDayKey walks the calendar instead.
    assert.equal(studyDay.shiftDayKey('2026-11-02', 1), '2026-11-01');
    assert.equal(studyDay.shiftDayKey('2026-11-01', 1), '2026-10-31');
    // Spring forward, 2026-03-08: a 23-hour day, which drops a day the other way.
    assert.equal(studyDay.shiftDayKey('2026-03-09', 1), '2026-03-08');
    assert.equal(studyDay.shiftDayKey('2026-03-08', 1), '2026-03-07');
  });
  // Month and year boundaries, which the same arithmetic has to cross.
  assert.equal(studyDay.shiftDayKey('2026-03-01', 1), '2026-02-28');
  assert.equal(studyDay.shiftDayKey('2027-01-01', 1), '2026-12-31');
  assert.equal(studyDay.shiftDayKey('2024-03-01', 1), '2024-02-29', 'leap year');
});

check('a day key renders as the day it names, in any timezone', () => {
  inTimezone('America/Los_Angeles', () => {
    // `new Date('2026-09-11')` is parsed as UTC midnight, which renders as the
    // 10th here — the group header would be off by one for half the world.
    const d = studyDay.dayKeyToDate('2026-09-11');
    assert.equal(d.getFullYear(), 2026);
    assert.equal(d.getMonth(), 8);
    assert.equal(d.getDate(), 11);
  });
});

// ── Free placement: the box layout (v1.13 follow-up) ───────────────────────
//
// The whole safety argument for this feature is that `content` stays the
// authority on the WORDS and `layout` only ever decides the ARRANGEMENT. Every
// assertion here is on that boundary: an old app version can edit `content`,
// and when it does, the layout has to step aside rather than garble the note.
const nbLayout = await import('../src/features/notebook/layout.js');

check('a note with no layout opens as one full-width box', () => {
  const { boxes, stale } = nbLayout.readLayout('first line\nsecond line', null);
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0].text, 'first line\nsecond line');
  assert.equal(boxes[0].x, 0);
  assert.equal(boxes[0].y, 0);
  assert.equal(boxes[0].w, nbLayout.MAX_W);
  // Nothing was discarded, so there is nothing to rewrite.
  assert.equal(stale, false, 'absent is not stale');
});

check('an arrangement round-trips through both columns', () => {
  const boxes = [
    nbLayout.makeBox({ x: 0.5, y: 56, w: 0.4, text: 'beside' }),
    nbLayout.makeBox({ x: 0.02, y: 0, w: 0.45, text: 'above' }),
  ];
  const { content, layout } = nbLayout.writeLayout(boxes);
  // Reading order, not insertion order: `content` is what a version with no
  // layout shows, so it has to read down the page and then across.
  assert.equal(content, 'above\n\nbeside');
  const back = nbLayout.readLayout(content, layout);
  assert.equal(back.stale, false);
  assert.equal(back.boxes.length, 2);
  assert.equal(back.boxes[0].text, 'above');
  assert.deepEqual(
    back.boxes.map((b) => [b.x, b.y, b.w]),
    [[0.02, 0, 0.45], [0.5, 56, 0.4]],
  );
});

check('a layout is JSON or an object, indifferently', () => {
  // Postgres hands back jsonb as an object; localStorage round-trips it as
  // whatever was stored. Both have to work or the note opens unarranged on
  // exactly one of the two paths.
  const { layout } = nbLayout.writeLayout([nbLayout.makeBox({ x: 0.1, y: 28, text: 'x' })]);
  assert.equal(nbLayout.readLayout('x', layout).stale, false);
  assert.equal(nbLayout.readLayout('x', JSON.stringify(layout)).stale, false);
});

check('content edited by another version WINS over a stale layout', () => {
  const { content, layout } = nbLayout.writeLayout([
    nbLayout.makeBox({ x: 0, y: 0, w: 0.5, text: 'mine' }),
    nbLayout.makeBox({ x: 0.5, y: 0, w: 0.5, text: 'beside' }),
  ]);
  assert.equal(content, 'mine\n\nbeside');
  // An app version that predates free placement edits the note. It knows
  // nothing about `layout`, so the column survives untouched and now describes
  // text that is no longer there.
  const edited = 'mine\n\nbeside\n\nadded on the old phone';
  const { boxes, stale } = nbLayout.readLayout(edited, layout);
  assert.equal(stale, true);
  assert.equal(boxes.length, 1, 'falls back to one box');
  assert.equal(boxes[0].text, edited, 'not one word of the edit is lost');
});

check('a malformed layout cannot make a note unopenable', () => {
  for (const bad of ['{not json', '{}', '[]', { boxes: 'nope' }, { boxes: [] }, null, undefined, 42]) {
    const { boxes } = nbLayout.readLayout('the words', bad);
    assert.equal(boxes.length, 1, `bad layout ${JSON.stringify(bad)}`);
    assert.equal(boxes[0].text, 'the words');
  }
  // Junk INSIDE an otherwise valid box is revived rather than thrown: a NaN
  // position must not put a box at `top: NaNpx`, which renders nowhere.
  const revived = nbLayout.readLayout('a', {
    v: 1, hash: nbLayout.hashContent('a'),
    boxes: [{ x: 'left', y: null, w: 99, text: 'a' }],
  });
  assert.equal(revived.stale, false);
  assert.equal(Number.isFinite(revived.boxes[0].x), true);
  assert.equal(Number.isFinite(revived.boxes[0].y), true);
  assert.equal(revived.boxes[0].w <= nbLayout.MAX_W, true);
});

check('a box cannot be placed where it can never be grabbed again', () => {
  const far = nbLayout.makeBox({ x: 2, y: -50, w: 5 });
  assert.equal(far.x <= 1 - nbLayout.MIN_W, true, 'stays on the page');
  assert.equal(far.y >= 0, true, 'never above the first ruling');
  assert.equal(far.x + far.w <= nbLayout.MAX_W + 1e-9, true, 'never wider than the page');
  const thin = nbLayout.makeBox({ x: 0.1, y: 0, w: 0.001 });
  assert.equal(thin.w >= nbLayout.MIN_W, true, 'never too narrow to type in');
});

check('a box top always lands on a ruling', () => {
  for (const y of [0, 13, 14, 27, 28, 41, 200.6]) {
    assert.equal(nbLayout.snapY(y) % nbLayout.GRID, 0, `snapY(${y})`);
  }
  assert.equal(nbLayout.snapY(-99), 0);
});

check('an unarranged note is recognised, so it stores no layout at all', () => {
  assert.equal(nbLayout.isUnarranged(nbLayout.singleBox('anything')), true);
  assert.equal(nbLayout.isUnarranged([nbLayout.makeBox({ x: 0.3, y: 0, w: 1, text: 'x' })]), false);
  assert.equal(nbLayout.isUnarranged([nbLayout.makeBox({ x: 0, y: 28, w: 1, text: 'x' })]), false);
  assert.equal(nbLayout.isUnarranged([
    nbLayout.makeBox({ x: 0, y: 0, w: 1, text: 'a' }),
    nbLayout.makeBox({ x: 0, y: 56, w: 1, text: 'b' }),
  ]), false);
});

check('the hash notices any edit, including a reordering', () => {
  const h = nbLayout.hashContent;
  assert.notEqual(h('a\n\nb'), h('b\n\na'), 'order-dependent');
  assert.notEqual(h('note'), h('note '), 'whitespace counts');
  assert.notEqual(h(''), h('x'));
  assert.equal(h('same'), h('same'), 'stable');
});

// ── dueWindow.js — what the course badge calls "due" (v1.14 Item 4, #51) ──
//
//   > "if you have put in all your assignments for the semester it says you
//      have like 20 assignments due which looks kind of alarming"
//
// The badge counted every open assignment that had a date at all and then
// painted itself red. The number was right; the word was not. These assertions
// pin the two rules that make the new count defensible rather than merely
// smaller — overdue work is NEVER dropped from the count, and an item nobody
// has given a date is not due — because both are the kind of thing a later
// "simplification" quietly loses.
const dueWindow = await import('../src/lib/dueWindow.js');

check('a fixed horizon counts up to and including its last day', () => {
  assert.equal(dueWindow.countsAsDue(0, 'Essay', 7), true, 'today');
  assert.equal(dueWindow.countsAsDue(7, 'Essay', 7), true, 'the boundary itself');
  assert.equal(dueWindow.countsAsDue(8, 'Essay', 7), false);
});

check('overdue always counts, at every setting', () => {
  for (const w of dueWindow.DUE_WINDOW_CHOICES) {
    assert.equal(dueWindow.countsAsDue(-1, 'Reading', w), true, `window ${w}`);
    assert.equal(dueWindow.countsAsDue(-90, 'Essay', w), true, `window ${w}`);
  }
});

check('an item with no due date is not due — it was counted before', () => {
  for (const w of dueWindow.DUE_WINDOW_CHOICES) {
    assert.equal(dueWindow.countsAsDue(null, 'Essay', w), false, `window ${w}`);
    assert.equal(dueWindow.countsAsDue(undefined, 'Essay', w), false, `window ${w}`);
  }
});

check('"by type" gives readings a shorter horizon than everything else', () => {
  assert.equal(dueWindow.horizonFor('Reading', 'smart'), 3);
  assert.equal(dueWindow.horizonFor('Essay', 'smart'), 14);
  assert.equal(dueWindow.horizonFor('Project', 'smart'), 14);
  // Free-text types come from the "Other" field, so the default has to catch
  // anything at all, including a name that collides with an Object prototype
  // key — `hasOwnProperty` rather than a bare lookup is what makes that true.
  assert.equal(dueWindow.horizonFor('Väitöskirja', 'smart'), 14);
  assert.equal(dueWindow.horizonFor('constructor', 'smart'), 14);
  assert.equal(dueWindow.horizonFor(undefined, 'smart'), 14);
  assert.equal(dueWindow.countsAsDue(5, 'Reading', 'smart'), false);
  assert.equal(dueWindow.countsAsDue(5, 'Essay', 'smart'), true);
});

check('"everything" is the behaviour this item changed, kept reachable', () => {
  assert.equal(dueWindow.horizonFor('Reading', 'all'), Infinity);
  assert.equal(dueWindow.countsAsDue(3650, 'Reading', 'all'), true);
  // Still not "everything open" — a dateless item has no due date to be past.
  assert.equal(dueWindow.countsAsDue(null, 'Reading', 'all'), false);
});

check('a junk stored preference falls back, it does not blank the badge', () => {
  const store = makeStorage();
  globalThis.localStorage = store.store;
  store.store.setItem('studydesk-due-window', 'banana');
  assert.equal(dueWindow.preferredDueWindow(), dueWindow.DEFAULT_DUE_WINDOW);
  store.store.setItem('studydesk-due-window', '9999');
  assert.equal(dueWindow.preferredDueWindow(), dueWindow.DEFAULT_DUE_WINDOW);
  // A number survives the string round trip localStorage forces on it.
  dueWindow.setPreferredDueWindow(14);
  assert.equal(dueWindow.preferredDueWindow(), 14);
  dueWindow.setPreferredDueWindow('all');
  assert.equal(dueWindow.preferredDueWindow(), 'all');
  // The default writes nothing, so the key only exists for people who chose.
  dueWindow.setPreferredDueWindow('smart');
  assert.equal(store.store.getItem('studydesk-due-window'), null);
});

// ── planSections.js — which Plan sections are folded (v1.14 Item 3, #51) ──
//
// A view preference, so the only behaviour worth pinning is what happens when
// the stored value is absent or wrong: every section must come back OPEN,
// because a fold nobody asked for looks exactly like a tab that lost its data.
const planSections = await import('../src/lib/planSections.js');

check('nothing folds itself — an absent or corrupt value reads as all open', () => {
  const store = makeStorage();
  globalThis.localStorage = store.store;
  for (const raw of [null, '', 'not json', '[]', '"assignments"', '{"assignments":"yes"}']) {
    if (raw === null) store.store.removeItem('studydesk-plan-collapsed');
    else store.store.setItem('studydesk-plan-collapsed', raw);
    const state = planSections.readCollapsed();
    for (const id of planSections.PLAN_SECTIONS) {
      assert.equal(state[id], false, `${id} after ${JSON.stringify(raw)}`);
    }
  }
});

check('a fold round-trips, and unfolding everything removes the key', () => {
  const store = makeStorage();
  globalThis.localStorage = store.store;
  planSections.writeCollapsed({ assignments: false, exams: true, courses: false });
  assert.deepEqual(planSections.readCollapsed(), { assignments: false, exams: true, courses: false });
  planSections.writeCollapsed({ assignments: false, exams: false, courses: false });
  assert.equal(store.store.getItem('studydesk-plan-collapsed'), null);
});

// ── dueAt.js — a deadline has a time now (v1.14 Item 5, #51) ─────────────
//
// Three things here are load-bearing and none of them is the feature itself.
//
// 1. An untimed assignment is END OF its day, not the start of it. Every one
//    of the 317 live assignment rows is untimed, so getting this backwards
//    would resort every existing list the first time anyone typed a 09:00.
// 2. The sort key is a STRING. `new Date('2026-09-14')` is UTC midnight and
//    `new Date('2026-09-14T09:00')` is LOCAL — mixing timed and untimed items
//    through the Date constructor sorts them on two different clocks, and the
//    TZ switching below is what makes that visible on a UTC CI runner.
// 3. The due-day reminder may move EARLIER but never later, and never lands
//    on the day before.
const dueAt = await import('../src/lib/dueAt.js');

check('a Postgres time, an input value and junk all normalise to HH:MM', () => {
  assert.equal(dueAt.normalizeDueTime('09:00:00'), '09:00', 'the column shape');
  assert.equal(dueAt.normalizeDueTime('09:00'), '09:00', 'the input shape');
  assert.equal(dueAt.normalizeDueTime('9:05'), '09:05', 'unpadded');
  assert.equal(dueAt.normalizeDueTime(''), '');
  assert.equal(dueAt.normalizeDueTime(null), '');
  assert.equal(dueAt.normalizeDueTime(undefined), '', 'the column not existing yet');
  assert.equal(dueAt.normalizeDueTime('banana'), '');
  assert.equal(dueAt.normalizeDueTime('99:99'), '');
  // Postgres accepts 24:00 in a `time`; there is no such reading on a clock,
  // so it reads as "no time given" — which already sorts at end of day, which
  // is what 24:00 meant. Nothing in the app writes one.
  assert.equal(dueAt.normalizeDueTime('24:00:00'), '');
  assert.equal(dueAt.dueSortKey('2026-09-14', '24:00:00'), `2026-09-14T${dueAt.END_OF_DAY}`);
  assert.equal(dueAt.dueTimeToSql('09:00'), '09:00:00');
  assert.equal(dueAt.dueTimeToSql(''), null, 'a `time` column rejects the empty string');
});

check('an untimed assignment is the END of its day, never the start', () => {
  assert.equal(dueAt.dueSortKey('2026-09-14', ''), '2026-09-14T23:59');
  assert.equal(dueAt.dueSortKey('2026-09-14', '09:00'), '2026-09-14T09:00');
  // The whole point: 09:00 comes FIRST on the same day.
  assert.ok(dueAt.dueSortKey('2026-09-14', '09:00') < dueAt.dueSortKey('2026-09-14', ''));
  // Undated last, as the "9999-12-31" fallback it replaces did.
  assert.ok(dueAt.dueSortKey('', '') > dueAt.dueSortKey('2099-01-01', '23:59'));
});

check('the sort is timezone-independent, timed and untimed items together', () => {
  const items = [
    { id: 'none' },
    { id: 'fri-late', dueDate: '2026-09-18', dueTime: '17:00' },
    { id: 'fri-none', dueDate: '2026-09-18' },
    { id: 'fri-9am', dueDate: '2026-09-18', dueTime: '09:00' },
    { id: 'thu', dueDate: '2026-09-17', dueTime: '23:30' },
  ];
  const expected = ['thu', 'fri-9am', 'fri-late', 'fri-none', 'none'];
  for (const tz of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo', 'Pacific/Kiritimati']) {
    inTimezone(tz, () => {
      assert.deepEqual([...items].sort(dueAt.byDueAsc).map((x) => x.id), expected, tz);
    });
  }
});

check('descending keeps undated LAST too, rather than floating it to the top', () => {
  const items = [
    { id: 'none' },
    { id: 'old', dueDate: '2026-01-05' },
    { id: 'new', dueDate: '2026-09-18', dueTime: '09:00' },
  ];
  assert.deepEqual([...items].sort(dueAt.byDueDesc).map((x) => x.id), ['new', 'old', 'none']);
});

check('the deadline instant is local, not UTC', () => {
  inTimezone('America/Los_Angeles', () => {
    const d = dueAt.dueMoment('2026-09-18', '09:00');
    assert.equal(d.getFullYear(), 2026);
    assert.equal(d.getMonth(), 8);
    assert.equal(d.getDate(), 18, 'the 18th in Los Angeles, not the 17th');
    assert.equal(d.getHours(), 9);
  });
  assert.equal(dueAt.dueMoment('', '09:00'), null);
  assert.equal(dueAt.dueMoment(null, null), null);
  // No time means the end of the day, the same rule the sort key uses.
  const untimed = dueAt.dueMoment('2026-09-18', '');
  assert.equal(untimed.getHours(), 23);
  assert.equal(untimed.getMinutes(), 59);
});

check('the due-day reminder moves earlier when it must, and never later', () => {
  const at = (date, time) => dueAt.dueDayReminderAt(date, time);
  // Untimed: unchanged from before this item — 9am.
  const untimed = at('2026-09-18', '');
  assert.equal(untimed.getHours(), 9);
  assert.equal(untimed.getMinutes(), 0);
  // An evening deadline keeps 9am; moving it later would be a regression.
  assert.equal(at('2026-09-18', '17:00').getHours(), 9);
  assert.equal(at('2026-09-18', '10:00').getHours(), 9, 'exactly an hour after 9 still gets 9');
  // An early deadline pulls it forward to an hour before.
  const early = at('2026-09-18', '08:00');
  assert.equal(early.getHours(), 7);
  assert.equal(early.getDate(), 18, 'still the due day');
  // Too early to warn on the day at all — the 6pm day-before reminder has it.
  assert.equal(at('2026-09-18', '00:30'), null);
  assert.equal(at('2026-09-18', '00:00'), null);
  // 01:00 is the boundary: an hour before is exactly midnight, which is still
  // the due day, so the reminder fires rather than being dropped. Anything
  // earlier than 01:00 pushes it into yesterday and is dropped.
  const boundary = at('2026-09-18', '01:00');
  assert.equal(boundary.getDate(), 18);
  assert.equal(boundary.getHours(), 0);
  assert.equal(boundary.getMinutes(), 0);
  assert.equal(at('2026-09-18', '00:59'), null, 'one minute earlier lands yesterday');
  assert.equal(at('', '09:00'), null);
});

// ── widget/glance.js — the one assignment the widget leads with ───────────
//
// The widget has room for exactly one, so its tie-break is the whole feature.
// Before due times existed, two things due the same day were a genuine tie and
// the name decided; now one of them may carry a time the user typed and the
// other may not, and the untimed one must not win on alphabetical order.
const glance = await import('../src/widget/glance.js');

check('the widget leads with the soonest deadline, not the soonest day', () => {
  const courses = {};
  const pick = (assignments) => glance.nextDue({ assignments, courses }, '2026-09-18')?.title;

  assert.equal(pick([
    { id: '1', title: 'Zebra', dueDate: '2026-09-18', dueTime: '09:00' },
    { id: '2', title: 'Apple', dueDate: '2026-09-18' },
  ]), 'Zebra', 'a typed 09:00 beats an untimed one, alphabet notwithstanding');

  assert.equal(pick([
    { id: '1', title: 'Later', dueDate: '2026-09-18', dueTime: '17:00' },
    { id: '2', title: 'Earlier', dueDate: '2026-09-18', dueTime: '08:00' },
  ]), 'Earlier');

  // An earlier DAY still wins outright, however late in it.
  assert.equal(pick([
    { id: '1', title: 'Tomorrow 8am', dueDate: '2026-09-19', dueTime: '08:00' },
    { id: '2', title: 'Tonight', dueDate: '2026-09-18', dueTime: '23:30' },
  ]), 'Tonight');

  // Same instant: the name decides, as it always did, so the widget does not
  // reshuffle between polls.
  assert.equal(pick([
    { id: '1', title: 'Beta', dueDate: '2026-09-18', dueTime: '09:00' },
    { id: '2', title: 'Alpha', dueDate: '2026-09-18', dueTime: '09:00' },
  ]), 'Alpha');

  // Overdue still outranks everything — unchanged by this item.
  assert.equal(pick([
    { id: '1', title: 'Today 8am', dueDate: '2026-09-18', dueTime: '08:00' },
    { id: '2', title: 'Missed', dueDate: '2026-09-15' },
  ]), 'Missed');
});

// ── commitments.js — blockers every N weeks (v1.14 Item 7b, #51) ─────────
//
//   > "I also have obligations that are every 2 weeks, and the blockers can
//      only be weekly."
//
// The phase is the whole risk here. "Every other Thursday from the 15th" where
// the 15th is a TUESDAY means the 17th and the 31st, and counting from the
// 15th instead picks the 24th — the wrong Thursdays, silently, forever. The
// other risk is the safe-direction rule: anything unreadable must show the
// blocker, because a student who plans study into a training session is worse
// off than one who sees a blocker on a free week.
const commitments = await import('../src/lib/commitments.js');

const THU = 4;
const weekdayOf = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
};
const on = (c, iso) => commitments.occursOn(c, iso, weekdayOf(iso));

check('an absent, junk or 1 interval all mean every week', () => {
  for (const v of [undefined, null, '', 0, 1, -3, NaN, 'banana']) {
    assert.equal(commitments.intervalWeeks({ intervalWeeks: v }), 1, String(v));
  }
  assert.equal(commitments.intervalWeeks({ intervalWeeks: 2 }), 2);
  assert.equal(commitments.intervalWeeks({ intervalWeeks: '3' }), 3);
  // Clamped, not rejected: a hand-edited 99 behaves like the longest interval
  // the app can express rather than vanishing from the calendar.
  assert.equal(commitments.intervalWeeks({ intervalWeeks: 99 }), 4);
});

check('the series is anchored to the first occurrence, not the start date', () => {
  // 2026-09-15 is a Tuesday. A Thursday commitment starting then first occurs
  // on the 17th — counting from the 15th would pick the 24th.
  const c = { weekday: THU, startsOn: '2026-09-15', intervalWeeks: 2 };
  assert.equal(commitments.firstOccurrence(c), '2026-09-17');
  assert.equal(on(c, '2026-09-17'), true, 'first');
  assert.equal(on(c, '2026-09-24'), false, 'the week in between');
  assert.equal(on(c, '2026-10-01'), true, 'second');
  assert.equal(on(c, '2026-10-08'), false);
  assert.equal(on(c, '2026-10-15'), true, 'third');
  // A start date already on the weekday anchors to itself.
  assert.equal(commitments.firstOccurrence({ weekday: THU, startsOn: '2026-09-17' }), '2026-09-17');
});

check('every week is unchanged, and one-offs are untouched by any of this', () => {
  const weekly = { weekday: THU, startsOn: '2026-09-17' };
  for (const iso of ['2026-09-17', '2026-09-24', '2026-10-01', '2026-10-08']) {
    assert.equal(on(weekly, iso), true, iso);
  }
  const once = { weekday: null, startsOn: '2026-09-17', intervalWeeks: 3 };
  assert.equal(on(once, '2026-09-17'), true);
  assert.equal(on(once, '2026-09-24'), false);
});

check('an interval does not override the start and end dates', () => {
  const c = { weekday: THU, startsOn: '2026-09-17', endsOn: '2026-10-01', intervalWeeks: 2 };
  assert.equal(on(c, '2026-09-10'), false, 'before it starts');
  assert.equal(on(c, '2026-09-17'), true);
  assert.equal(on(c, '2026-10-01'), true, 'the end date itself is included');
  assert.equal(on(c, '2026-10-15'), false, 'after it ends');
});

check('a fortnightly blocker keeps its phase across a DST transition', () => {
  // Europe's clocks go back on 2026-10-25 and America's on 2026-11-01. An
  // interval computed by dividing raw timestamps drifts by an hour there,
  // which is enough to land a boundary on the wrong side and skip a week.
  const c = { weekday: THU, startsOn: '2026-10-15', intervalWeeks: 2 };
  const expected = [
    ['2026-10-15', true], ['2026-10-22', false],
    ['2026-10-29', true], ['2026-11-05', false],
    ['2026-11-12', true], ['2026-11-19', false],
    ['2026-11-26', true],
  ];
  for (const tz of ['UTC', 'Europe/Helsinki', 'America/Los_Angeles']) {
    inTimezone(tz, () => {
      for (const [iso, want] of expected) assert.equal(on(c, iso), want, `${tz} ${iso}`);
    });
  }
});

check('an unreadable row shows the blocker rather than hiding it', () => {
  // A date that cannot be parsed must not silently remove a training session
  // from the week the student is planning around.
  // A start date that sorts before the day being asked about (so the existing
  // string guard lets it through) but does not parse into a real date.
  assert.equal(on({ weekday: THU, startsOn: '0000-xx-xx', intervalWeeks: 2 }, '2026-10-15'), true);
  assert.equal(commitments.firstOccurrence({ weekday: THU, startsOn: '0000-xx-xx' }), null);
  assert.equal(commitments.firstOccurrence({ weekday: THU, startsOn: '' }), null);
  assert.equal(commitments.occursOn(null, '2026-10-15', THU), false);
});

// ── gradeWeight.js — what the Weight field means (v1.14 Item 8b, #51) ────
//
//   > "the weight thing is a bit confusing, I don't know if I should put 0.35
//      for something worth 35% of the grade or what"
//
// Storage does not change: `weight` stays the multiplicative factor and no
// existing average moves. What is asserted here is the two rules that make
// the conversion layer safe to put in front of it — round-tripping a value
// through a mode change must not alter it, and the share readout must give
// the same answer whatever units the course's weights happen to be in, since
// that is the claim the whole control rests on.
const gradeWeight = await import('../src/lib/gradeWeight.js');

check('a weight round-trips through every entry mode unchanged', () => {
  for (const factor of [0, 0.1, 0.35, 1, 2.5, 35, 100]) {
    for (const mode of gradeWeight.WEIGHT_MODES) {
      const shown = gradeWeight.fromFactor(mode, factor, 100);
      assert.equal(gradeWeight.toFactor(mode, shown, 100), factor, `${mode} ${factor}`);
    }
  }
  // The float noise this exists to hide: 0.35 * 100 is 35.000000000000004.
  assert.equal(gradeWeight.fromFactor('percent', 0.35), 35);
  assert.equal(gradeWeight.toFactor('percent', 35), 0.35);
});

check('each mode converts the way the user means it', () => {
  assert.equal(gradeWeight.toFactor('factor', '0.35'), 0.35, 'unchanged behaviour');
  assert.equal(gradeWeight.toFactor('percent', '35'), 0.35);
  assert.equal(gradeWeight.toFactor('points', '10', 100), 0.1);
  assert.equal(gradeWeight.toFactor('points', '30', 60), 0.5, 'a course out of 60');
});

check('an unusable weight is reported, not quietly turned into 1', () => {
  for (const bad of ['', 'banana', -1, NaN, null, undefined]) {
    assert.equal(gradeWeight.toFactor('factor', bad), null, String(bad));
  }
  // Dividing by a zero-point course would store Infinity in a numeric column.
  assert.equal(gradeWeight.toFactor('points', '10', 0), null);
  assert.equal(gradeWeight.toFactor('points', '10', -5), null);
  assert.equal(gradeWeight.toFactor('points', '10', 'x'), null);
  assert.equal(gradeWeight.fromFactor('points', 0.1, 0), null);
});

check('the share of a course reads the same in any units', () => {
  const asShares = (ws) => ws.map((w) => gradeWeight.shareOfCourse(w, ws));
  // 35 / 30 / 35 and 0.35 / 0.30 / 0.35 are the same course, which is exactly
  // why the raw weight was ambiguous and the share is not.
  assert.deepEqual(asShares([35, 30, 35]), [0.35, 0.3, 0.35]);
  assert.deepEqual(asShares([0.35, 0.3, 0.35]), [0.35, 0.3, 0.35]);
  assert.deepEqual(asShares([7, 6, 7]), [0.35, 0.3, 0.35]);
  // A course carrying no weight has no shares in it — undefined, not zero.
  assert.equal(gradeWeight.shareOfCourse(0, [0, 0]), null);
  assert.equal(gradeWeight.shareOfCourse(1, []), null);
  assert.equal(gradeWeight.shareOfCourse('x', [1]), null);
  // Junk among the siblings is skipped rather than poisoning the sum.
  assert.equal(gradeWeight.shareOfCourse(1, [1, 'x', null, 1]), 0.5);
});

check('the entry mode is remembered, and the default writes nothing', () => {
  const store = makeStorage();
  globalThis.localStorage = store.store;
  assert.equal(gradeWeight.preferredWeightMode(), gradeWeight.DEFAULT_WEIGHT_MODE);
  gradeWeight.setPreferredWeightMode('percent');
  assert.equal(gradeWeight.preferredWeightMode(), 'percent');
  store.store.setItem('studydesk-weight-mode', 'banana');
  assert.equal(gradeWeight.preferredWeightMode(), gradeWeight.DEFAULT_WEIGHT_MODE, 'junk falls back');
  gradeWeight.setPreferredWeightMode('factor');
  assert.equal(store.store.getItem('studydesk-weight-mode'), null, 'the default stores nothing');
});

// ── timetable.js flattenTerms — the scope picker's list (v1.14 Item 6b) ──
//
//   > "there's no way to move a lesson between the year, the semester and the
//      jakso without deleting it and typing it in again"
//
// The move itself is a foreign key edit; what needed building was a way to
// SEE the tree as one list. Ordering is the thing worth pinning — a jakso is
// ordinal, so `position` decides, and a parent must appear above its children
// or the indentation lies about the structure.
const ttFlat = await import('../src/lib/timetable.js');

check('the term tree flattens depth-first, parents above their children', () => {
  const terms = [
    { id: 'y1', parentId: null, name: '2026-27', position: 0 },
    { id: 's2', parentId: 'y1', name: 'Spring', position: 1 },
    { id: 's1', parentId: 'y1', name: 'Autumn', position: 0 },
    { id: 'j2', parentId: 's1', name: 'Jakso 2', position: 1 },
    { id: 'j1', parentId: 's1', name: 'Jakso 1', position: 0 },
    { id: 'y0', parentId: null, name: '2025-26', position: 1 },
  ];
  assert.deepEqual(
    ttFlat.flattenTerms(terms).map(({ term, depth }) => `${depth}:${term.id}`),
    ['0:y1', '1:s1', '2:j1', '2:j2', '1:s2', '0:y0'],
  );
});

check('a deleted term is not offered as somewhere to move a lesson', () => {
  const terms = [
    { id: 'y1', parentId: null, name: 'Year', position: 0 },
    { id: 'gone', parentId: 'y1', name: 'Deleted', position: 0, deletedAt: '2026-01-01T00:00:00Z' },
    { id: 's1', parentId: 'y1', name: 'Autumn', position: 1 },
  ];
  assert.deepEqual(ttFlat.flattenTerms(terms).map(({ term }) => term.id), ['y1', 's1']);
});

check('a cyclic parent chain terminates instead of hanging the picker', () => {
  // Not reachable through the UI, but a corrupt pull must not spin forever in
  // a render path — the tree is three levels by design.
  const terms = [
    { id: 'a', parentId: 'b', name: 'A', position: 0 },
    { id: 'b', parentId: 'a', name: 'B', position: 0 },
  ];
  const flat = ttFlat.flattenTerms(terms);
  assert.ok(Array.isArray(flat));
  assert.ok(flat.length < 100, `bounded, got ${flat.length}`);
});

// ── timetable.js planSeriesWrite — a lesson on several weekdays (Item 6a) ─
//
//   > "there's no way to say this is the same course, just also on Wednesday"
//
// `weekday` stays one smallint per row; a nullable `series_id` says which rows
// belong together. All the risk is in the reconcile, and all of it is the same
// risk: `lesson_attendance` is keyed on the ENTRY id, so a row that loses its
// id loses its attendance history. These assertions exist to pin that ids are
// matched on the WEEKDAY and never positionally — the failure mode of a
// positional diff is silent and moves one day's attendance onto another.
const ttSeries = await import('../src/lib/timetable.js');

let seq = 0;
const nextId = () => `new-${++seq}`;
const plan = (existing, weekdays, base = {}) => {
  seq = 0;
  return ttSeries.planSeriesWrite({ existing, seriesId: 'S', weekdays, base, newId: nextId });
};
const entry = (id, weekday, extra = {}) => ({ id, weekday, seriesId: 'S', ...extra });

check('adding a day keeps the id of every existing row', () => {
  const { upserts, deleteIds } = plan([entry('mon', 1)], [1, 3]);
  assert.deepEqual(upserts.map((u) => [u.weekday, u.id]), [[1, 'mon'], [3, 'new-1']]);
  assert.deepEqual(deleteIds, []);
});

check('a day added in the MIDDLE does not shuffle ids down the list', () => {
  // The positional-diff failure, stated as a test. Mon and Fri exist; the user
  // adds Wednesday. A positional match would hand Wednesday the Friday row's
  // id and mint a new one for Friday — moving Friday's attendance to Wednesday
  // and losing it for Friday, with nothing on screen to say so.
  const { upserts, deleteIds } = plan([entry('mon', 1), entry('fri', 5)], [1, 3, 5]);
  assert.deepEqual(upserts.map((u) => [u.weekday, u.id]), [[1, 'mon'], [3, 'new-1'], [5, 'fri']]);
  assert.deepEqual(deleteIds, []);
});

check('removing a day deletes that day and leaves the others alone', () => {
  const { upserts, deleteIds } = plan([entry('mon', 1), entry('wed', 3), entry('fri', 5)], [1, 5]);
  assert.deepEqual(upserts.map((u) => [u.weekday, u.id]), [[1, 'mon'], [5, 'fri']]);
  assert.deepEqual(deleteIds, ['wed']);
});

check('every day carries the shared fields, and only the weekday differs', () => {
  const base = { termId: 'T1', subjectId: 'C1', startsAt: '08:15:00', endsAt: '09:45:00', weekParity: 2 };
  const { upserts } = plan([], [1, 3], base);
  for (const u of upserts) {
    assert.equal(u.termId, 'T1');
    assert.equal(u.startsAt, '08:15:00');
    assert.equal(u.weekParity, 2, 'parity is a property of the lesson, not of one day');
    assert.equal(u.seriesId, 'S');
  }
  assert.deepEqual(upserts.map((u) => u.weekday), [1, 3]);
});

check('saving with no days selected writes nothing at all', () => {
  // Not "deletes the series". Save is not a delete, and planSeriesWrite is not
  // the only possible caller of itself, so it refuses rather than trusting the
  // form's validation to be the only guard.
  const { upserts, deleteIds } = plan([entry('mon', 1), entry('wed', 3)], []);
  assert.deepEqual(upserts, []);
  assert.deepEqual(deleteIds, []);
});

check('junk weekdays are dropped and duplicates collapse', () => {
  // `null` and `''` are the ones that matter: `Number` turns both into 0,
  // which is Sunday, so a missing value would become a real lesson on a real
  // day. Sunday is a legitimate answer when someone actually picks it.
  const { upserts } = plan([], [3, 3, 1, 9, -1, null, undefined, '', 'x', 2.5]);
  assert.deepEqual(upserts.map((u) => u.weekday), [1, 3], 'sorted, unique, 0-6 only');
  assert.deepEqual(plan([], [0]).upserts.map((u) => u.weekday), [0], 'a chosen Sunday survives');
});

check('a duplicate row on one weekday is resolved, not left orphaned', () => {
  // Not reachable through the editor, but a bad merge could deliver it. One
  // row is kept and the other is deleted — leaving it would put two lessons on
  // the same day in the grid with no way to reach the second.
  const { upserts, deleteIds } = plan([entry('a', 1), entry('b', 1)], [1]);
  assert.deepEqual(upserts.map((u) => u.id), ['a']);
  assert.deepEqual(deleteIds, ['b']);
});

check('soft-deleted rows are not resurrected by a save', () => {
  const { upserts, deleteIds } = plan(
    [entry('mon', 1), entry('gone', 3, { deletedAt: '2026-01-01T00:00:00Z' })],
    [1, 3],
  );
  assert.deepEqual(upserts.map((u) => [u.weekday, u.id]), [[1, 'mon'], [3, 'new-1']]);
  assert.deepEqual(deleteIds, [], 'already gone, not deleted again');
});

check('an ungrouped lesson is not a series of every ungrouped lesson', () => {
  const entries = [
    { id: 'a', weekday: 1, seriesId: null },
    { id: 'b', weekday: 2 },
    { id: 'c', weekday: 3, seriesId: 'S' },
  ];
  assert.deepEqual(ttSeries.entriesInSeries(entries, null).map((e) => e.id), []);
  assert.deepEqual(ttSeries.entriesInSeries(entries, undefined).map((e) => e.id), []);
  assert.deepEqual(ttSeries.entriesInSeries(entries, 'S').map((e) => e.id), ['c']);
});

// ── planRepeat.js — planned blocks that repeat (v1.14 Item 7a, #51) ──────
//
//   > "planned study sessions can't repeat, only the blockers can"
//
// The recurrence is MATERIALISED — N ordinary rows at creation — because a
// planned block, unlike a blocker, carries per-occurrence state: it is logged,
// dismissed, or still owed. So what needs pinning is not a recurrence rule but
// the three things that stop materialising going wrong: the horizon is bounded,
// the series keeps its phase across a DST change, and "stop repeating" cannot
// touch a block that already points at a real study session.
const planRepeat = await import('../src/lib/planRepeat.js');

check('a repeat runs to the end of the term it starts in', () => {
  const terms = [
    { id: 'y', parentId: null, name: 'Year', startsOn: '2026-08-01', endsOn: '2027-05-31', position: 0 },
    { id: 's', parentId: 'y', name: 'Autumn', startsOn: '2026-08-01', endsOn: '2026-12-20', position: 0 },
    { id: 'j', parentId: 's', name: 'Jakso 1', startsOn: '2026-08-01', endsOn: '2026-10-10', position: 0 },
  ];
  // Most specific wins — the same rule `lessonsOn` applies to timetables.
  assert.equal(planRepeat.repeatHorizon('2026-09-15', terms), '2026-10-10');
  // A date inside the semester but past the jakso falls back to the semester.
  assert.equal(planRepeat.repeatHorizon('2026-11-01', terms), '2026-12-20');
  // Outside every term: twelve weeks, a term-shaped answer to a termless
  // question. 2026-07-01 + 84 days.
  assert.equal(planRepeat.repeatHorizon('2026-07-01', terms), '2026-09-23');
  assert.equal(planRepeat.repeatHorizon('2026-07-01', []), '2026-09-23');
});

check('a term with no end date cannot make an unbounded series', () => {
  const terms = [{ id: 'y', parentId: null, name: 'Open', startsOn: '2026-08-01', position: 0 }];
  // Falls through to the 12-week default rather than "no limit".
  assert.equal(planRepeat.repeatHorizon('2026-09-01', terms), '2026-11-24');
});

check('the series keeps its weekday across a DST transition', () => {
  // Europe's clocks go back 2026-10-25. Adding 7×86400000ms would drift an
  // hour and, on a date near midnight, onto the wrong day.
  const dates = planRepeat.occurrenceDates('2026-10-15', 1, '2026-11-12');
  assert.deepEqual(dates, ['2026-10-15', '2026-10-22', '2026-10-29', '2026-11-05', '2026-11-12']);
  for (const tz of ['UTC', 'Europe/Helsinki', 'America/Los_Angeles']) {
    inTimezone(tz, () => {
      assert.deepEqual(planRepeat.occurrenceDates('2026-10-15', 2, '2026-11-26'),
        ['2026-10-15', '2026-10-29', '2026-11-12', '2026-11-26'], tz);
    });
  }
});

check('the horizon is inclusive, and a repeat always yields at least the block drawn', () => {
  assert.deepEqual(planRepeat.occurrenceDates('2026-09-01', 1, '2026-09-08'), ['2026-09-01', '2026-09-08']);
  assert.deepEqual(planRepeat.occurrenceDates('2026-09-01', 1, '2026-09-07'), ['2026-09-01']);
  // A horizon before the start, or no repeat at all, still gives the one block
  // the user actually placed on the calendar.
  assert.deepEqual(planRepeat.occurrenceDates('2026-09-01', 1, '2026-08-01'), ['2026-09-01']);
  assert.deepEqual(planRepeat.occurrenceDates('2026-09-01', 0, '2026-12-01'), ['2026-09-01']);
  assert.deepEqual(planRepeat.occurrenceDates('', 1, '2026-12-01'), []);
});

check('a mistyped term end cannot mint an unbounded number of rows', () => {
  // The horizon comes from user data. "Ends 2126" is one keystroke away, and
  // without the cap that is a hundred thousand rows in one tap.
  const dates = planRepeat.occurrenceDates('2026-09-01', 1, '2126-01-01');
  assert.equal(dates.length, planRepeat.MAX_OCCURRENCES);
});

check('stop-repeating never removes a block that already happened', () => {
  const rows = [
    { id: 'a', seriesId: 'S', startsAt: '2026-09-01T18:00:00Z', fulfilledBy: 'sess-1' },
    { id: 'b', seriesId: 'S', startsAt: '2026-09-08T18:00:00Z', dismissedAt: '2026-09-08T20:00:00Z' },
    { id: 'c', seriesId: 'S', startsAt: '2026-09-15T18:00:00Z' },
    { id: 'd', seriesId: 'S', startsAt: '2026-09-22T18:00:00Z' },
    { id: 'e', seriesId: 'OTHER', startsAt: '2026-09-22T18:00:00Z' },
    { id: 'f', seriesId: 'S', startsAt: '2026-09-29T18:00:00Z', deletedAt: '2026-09-01T00:00:00Z' },
  ];
  const later = planRepeat.laterInSeries(rows, 'S', '2026-09-08T18:00:00Z');
  assert.deepEqual(later.map((p) => p.id), ['c', 'd'],
    'logged and dismissed excluded, other series excluded, already-deleted excluded');
  // Backwards is never in scope: this is "stop repeating", not "erase history".
  assert.deepEqual(
    planRepeat.laterInSeries(rows, 'S', '2026-09-22T18:00:00Z').map((p) => p.id), ['d'],
  );
  // A one-off has no series, so nothing is ever swept up with it.
  assert.deepEqual(planRepeat.laterInSeries(rows, null, '2026-01-01T00:00:00Z'), []);
  assert.deepEqual(planRepeat.laterInSeries(rows, undefined, '2026-01-01T00:00:00Z'), []);
});

// ── v1.14 Item 2 (CTO's 2026-09-14 preset decision) ──────────────────────

const gradeScale = await import('../src/lib/gradeScale.js');

check('every scale chip is EITHER a scale to start from OR a mode to switch to', () => {
  for (const p of gradeScale.SCALE_PRESETS) {
    const isScale = !!p.scale;
    const isMode = !!p.mode;
    assert.ok(isScale !== isMode,
      `preset ${p.id} must carry exactly one of scale/mode, not both or neither`);
    assert.ok(p.labelKey, `preset ${p.id} needs a translated label`);
  }
});

check('a mode chip names a real grade mode, never a made-up one', () => {
  // The whole point of a mode chip is that it hands the user the built-in
  // scale rather than a copy of its numbers. A typo here would silently do
  // the opposite — SET_GRADE_MODE with a value isGradeMode rejects.
  for (const p of gradeScale.SCALE_PRESETS.filter((x) => x.mode)) {
    assert.ok(gradeScale.isGradeMode(p.mode), `${p.id} -> ${p.mode} is not a grade mode`);
    assert.notEqual(p.mode, 'custom', `${p.id} switching to custom would be a no-op`);
  }
});

check('no scale chip duplicates a built-in mode', () => {
  // This is the rule the two-front-doors problem comes down to. If a chip
  // that WRITES numbers ever matches what a built-in mode already means, the
  // app has two ways to express one scale and they can drift apart.
  const builtin = [
    gradeScale.scaleFor('ib'),
    gradeScale.scaleFor('us'),
  ].map((s) => `${s.min}-${s.max}-${s.passMark}-${s.direction}`);
  for (const p of gradeScale.SCALE_PRESETS.filter((x) => x.scale)) {
    const n = gradeScale.normalizeScale(p.scale);
    const sig = `${n.min}-${n.max}-${n.passMark}-${n.direction}`;
    assert.ok(!builtin.includes(sig),
      `${p.id} has the same bounds as a built-in mode — make it a mode chip instead`);
  }
});

check('the four the CTO asked for are all reachable', () => {
  const ids = gradeScale.SCALE_PRESETS.map((p) => p.id);
  for (const id of ['fr20', 'usgpa', 'ib', 'pct']) {
    assert.ok(ids.includes(id), `missing preset ${id}`);
  }
  // Kept deliberately: Finland is not on the CTO's list, but it shipped, and
  // it is still DEFAULT_CUSTOM_SCALE. Asserted so removing it is a decision.
  assert.ok(ids.includes('fi410'), 'the shipped Finland chip was dropped silently');
});

check('US GPA survives a round trip through normalizeScale', () => {
  // normalizeScale is total and rewrites anything it dislikes, so a preset
  // that it quietly "fixes" would put different numbers on screen than the
  // ones written here.
  const raw = gradeScale.SCALE_PRESETS.find((p) => p.id === 'usgpa').scale;
  const n = gradeScale.normalizeScale(raw);
  assert.equal(n.min, 0);
  assert.equal(n.max, 4);
  assert.equal(n.passMark, 1);
  assert.equal(n.direction, 'up');
});
