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
