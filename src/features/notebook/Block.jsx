// One rendered block. Never the focused one — that is a textarea in
// NoteEditor.jsx, and nothing here ever runs against text the user is
// currently typing into.
//
// **Nothing in this file builds an HTML string.** `renderInline` returns
// tokens and they become React elements. Note content is user-typed and, once
// it syncs, has crossed a network; `dangerouslySetInnerHTML` on it is how an
// editor grows an XSS hole, and a chemistry note contains `<` often enough
// that escaping-by-hand would be attempted and then got wrong.

import { memo } from 'react';
import { BLOCK } from './model.js';
import { renderInline, MARK } from './inline.js';
import { parseMaths, isFlat } from './render/maths.js';
import { renderChem } from './render/chem.js';
import { renderDiagram } from './render/diagram.js';

// ── Inline marks ──────────────────────────────────────────────────────────

const TAG = {
  [MARK.BOLD]: 'strong',
  [MARK.ITALIC]: 'em',
  [MARK.UNDERLINE]: 'u',
};
const CLS = {
  [MARK.BOLD]: 'nb-b',
  [MARK.ITALIC]: 'nb-i',
  [MARK.UNDERLINE]: 'nb-u',
};

function Inline({ text }) {
  const tokens = renderInline(text);
  return tokens.map((tok, i) => {
    let node = tok.text;
    // Innermost first, so the outermost mark is the outermost element and the
    // nesting in the DOM matches the nesting in the source.
    for (const mark of [...tok.marks].reverse()) {
      if (mark === MARK.HL) {
        // The role, never a colour. The CSS picks --nb-hl-{role}, so the same
        // stored note relights correctly in all five themes — §8 Trap 2.
        node = <mark key={`${i}hl`} className="nb-hl" data-role={tok.role || 1}>{node}</mark>;
      } else {
        const Tag = TAG[mark];
        if (!Tag) continue;
        node = <Tag key={`${i}${mark}`} className={CLS[mark]}>{node}</Tag>;
      }
    }
    return <span key={i}>{node}</span>;
  });
}

// ── §11 spans ─────────────────────────────────────────────────────────────
//
// A span is delimited so the parsers are never asked to guess. `In` is indium
// and also the word "in"; without a delimiter, chemistry rendering would fire
// on ordinary prose. The user's own `$…$` / `$$…$$` resolves it.
//
//   $ ... $     maths
//   $$ ... $$   chemistry
//
// A span that fails to parse renders as its LITERAL SOURCE in --nb-src and
// loses nothing. §11: "That is the entire error state. No red squiggle, no
// modal, no validation message."

function MathNodes({ nodes }) {
  return nodes.map((n, i) => {
    if (n.t === 'text') return <span key={i}>{n.v}</span>;
    if (n.t === 'frac' || n.t === 'binom') {
      return (
        <span key={i} className="nb-frac">
          <span className="nb-frac-num"><MathNodes nodes={n.num} /></span>
          <span className="nb-frac-den"><MathNodes nodes={n.den} /></span>
        </span>
      );
    }
    if (n.t === 'root') {
      return (
        <span key={i} className="nb-root">
          {n.kind === 'cbrt' ? '∛' : '√'}
          <span className="nb-root-body"><MathNodes nodes={n.body} /></span>
        </span>
      );
    }
    if (n.t === 'accent') return <span key={i}><MathNodes nodes={n.body} /></span>;
    return null;
  });
}

function ChemSpan({ result }) {
  const species = (sp, key) => (
    <span key={key}>
      {sp.coefficient !== 1 && <span>{sp.coefficient}</span>}
      {sp.tokens.map((tk, i) => (
        <span key={i} className={tk.kind === 'state' ? 'nb-src' : undefined}>{tk.text}</span>
      ))}
    </span>
  );

  if (result.kind === 'species') {
    return <span>{result.tokens.map((tk, i) => <span key={i}>{tk.text}</span>)}</span>;
  }

  return (
    <span>
      {result.sides.left.map((sp, i) => (
        <span key={`l${i}`}>{i > 0 && ' + '}{species(sp, i)}</span>
      ))}
      <span>{` ${result.arrow} `}</span>
      {result.sides.right.map((sp, i) => (
        <span key={`r${i}`}>{i > 0 && ' + '}{species(sp, i)}</span>
      ))}
    </span>
  );
}

/** The gutter tally — stacked symbol over have·need, per §11 design move 2. */
function Tally({ rows }) {
  if (!rows?.length) return null;
  return (
    <span className="nb-tally" aria-hidden="true">
      {rows.map((r) => (
        <span key={r.symbol} className={`nb-tally-row${r.ok ? '' : ' is-off'}`}>
          <span className="nb-tally-sym">{r.isCharge ? 'q' : r.symbol}</span>
          <span>{`${r.have}·${r.need}`}</span>
        </span>
      ))}
    </span>
  );
}

function Diagram({ data }) {
  if (data.kind === 'chain') {
    const W = 300;
    const step = data.nodes.length > 1 ? W / data.nodes.length : W;
    return (
      <svg className="nb-diagram" viewBox={`0 0 ${W} 34`} width="100%" height="34" role="img">
        {data.nodes.map((label, i) => (
          <g key={i}>
            <text className="nb-diagram-node" x={i * step + 4} y="20">{label}</text>
            {(i < data.nodes.length - 1 || data.cycle) && (
              <path
                className="nb-diagram-stroke"
                d={`M ${i * step + step - 16} 15 L ${i * step + step - 4} 15 M ${i * step + step - 8} 11 L ${i * step + step - 4} 15 L ${i * step + step - 8} 19`}
              />
            )}
          </g>
        ))}
      </svg>
    );
  }

  // Axes. The polyline is the SHAPE only — §11 is explicit that this never
  // carries data, which is why there are no tick marks and no scale.
  const W = 260;
  const H = 84;
  const pad = 22;
  const pts = data.points
    .map(([x, y]) => `${pad + x * (W - pad - 8)},${H - pad - y * (H - pad - 8)}`)
    .join(' ');
  return (
    <svg className="nb-diagram" viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img">
      <path className="nb-diagram-stroke" d={`M ${pad} 6 L ${pad} ${H - pad} L ${W - 6} ${H - pad}`} />
      <polyline className="nb-diagram-stroke" points={pts} />
      {data.y && <text className="nb-diagram-label" x="2" y="12">{data.y}</text>}
      {data.x && <text className="nb-diagram-label" x={W - 40} y={H - 6}>{data.x}</text>}
    </svg>
  );
}

// Split a line into plain runs and delimited spans. `$$` before `$`, longest
// first, the same precedence rule the inline marks use.
//
// The regex is built PER CALL rather than held at module scope. A `/g` regex
// carries `lastIndex` as mutable state, so a shared one is a hazard the
// moment two blocks render in the same tick — the second would resume from
// wherever the first stopped and silently drop its leading text.
const spanRe = () => /\$\$([^$]+)\$\$|\$([^$]+)\$/g;

function Rich({ text }) {
  const out = [];
  let last = 0;
  let m;
  const re = spanRe();

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ kind: 'text', v: text.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ kind: 'chem', v: m[1], raw: m[0] });
    else out.push({ kind: 'math', v: m[2], raw: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', v: text.slice(last) });

  const tally = [];

  const rendered = out.map((part, i) => {
    if (part.kind === 'text') return <Inline key={i} text={part.v} />;

    if (part.kind === 'chem') {
      const res = renderChem(part.v);
      if (!res) return <span key={i} className="nb-src">{part.raw}</span>;
      if (res.tally?.length) tally.push(...res.tally);
      return <ChemSpan key={i} result={res} />;
    }

    // Maths. A diagram is tried first only when the span reads like one —
    // `$a -> b$` is a chain, not an expression with a bad command in it.
    const diag = renderDiagram(part.v);
    if (diag) return <Diagram key={i} data={diag} />;

    const nodes = parseMaths(part.v);
    if (!nodes) return <span key={i} className="nb-src">{part.raw}</span>;
    if (isFlat(nodes)) return <span key={i}>{nodes.map((n) => n.v).join('')}</span>;
    return <MathNodes key={i} nodes={nodes} />;
  });

  return <>{rendered}<Tally rows={tally} /></>;
}

// ── The block ─────────────────────────────────────────────────────────────

function BlockView({ block, index, number, onFocus, onToggleCheck, photoUrl, onOpenPhoto }) {
  const common = {
    className: `nb-block nb-${block.type}`,
    'data-indent': block.indent || 0,
    onMouseDown: () => onFocus(index),
  };

  if (block.type === BLOCK.PHOTO) {
    return (
      <div className={`nb-block nb-photo-block`} data-indent="0">
        <figure className="nb-photo" onClick={() => onOpenPhoto?.(block.asset)}>
          {photoUrl
            ? <img src={photoUrl} alt={block.text || ''} />
            : <div className="nb-photo-cap">…</div>}
          {block.text && <figcaption className="nb-photo-cap">{block.text}</figcaption>}
        </figure>
      </div>
    );
  }

  if (block.type === BLOCK.CHECK) {
    return (
      <div {...common}>
        <button
          type="button"
          className="nb-check"
          role="checkbox"
          aria-checked={block.checked}
          // stopPropagation: tapping the box toggles it and must NOT also put
          // the caret in the line. Those are two different intentions and the
          // box is the smaller target of the two.
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onToggleCheck(index); }}
        />
        <span className={block.checked ? 'nb-text-done' : undefined}>
          <Rich text={block.text} />
        </span>
      </div>
    );
  }

  if (block.type === BLOCK.BULLET) {
    return (
      <div {...common}>
        <span className="nb-marker" aria-hidden="true">•</span>
        <Rich text={block.text} />
      </div>
    );
  }

  if (block.type === BLOCK.NUMBER) {
    return (
      <div {...common}>
        <span className="nb-marker" aria-hidden="true">{number}.</span>
        <Rich text={block.text} />
      </div>
    );
  }

  // An empty paragraph still needs a full line box, or the page collapses and
  // the ruling stops matching the text. A zero-width space would also work and
  // would end up in the user's clipboard.
  return <div {...common}>{block.text ? <Rich text={block.text} /> : ' '}</div>;
}

export default memo(BlockView);
