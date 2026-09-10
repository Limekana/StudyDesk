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
