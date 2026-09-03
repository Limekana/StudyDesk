// Appearance — the two axes, in one section, in the order they matter.
//
//   LIGHTING (free, v1.13):  Light · Dark · Black
//   CHARACTER (supporter):   Studio · Stacks · Slate
//
// Why lighting comes first: it is the choice every user has and the one they
// came here for. The supporter row sits below it, visible to everyone,
// because a perk nobody can see is not a perk — but it is not the first thing
// a free user has to scroll past to turn the lights down.
//
// ── The one consequence the build plan asked us to handle ────────────────
// Supporters bought Stacks and Slate partly BECAUSE they offered a dark
// option, and v1.13 gives that away. `appearance.characterNote` is the line
// that answers it, and it is placed under the supporter row rather than in a
// changelog so it is read next to the thing it is about. The claim it makes
// has to stay true: these themes have to keep earning their price on type,
// rules and marks rather than on not-being-bright.
//
// Selecting a paid theme deliberately does NOT clear the mode preference —
// see activeMode() in lib/theme.js. Turning the theme back off restores the
// dark mode the user was in, rather than dropping them onto a cream page.

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  MODES,
  THEMES,
  activeTheme,
  isPaidTheme,
  preferredMode,
  setPreferredMode,
  setPreferredTheme,
} from '../../lib/theme.js';
import { isEntitled } from '../../lib/entitlement.js';

// Swatch class per option. Kept as a lookup rather than a template string so
// a typo is a missing swatch at build time rather than a silently unstyled
// block at runtime.
const SWATCH = {
  light: 'is-free',
  dark: 'is-dark',
  black: 'is-black',
  free: 'is-free',
  stacks: 'is-stacks',
  slate: 'is-slate',
};

function Option({ id, labelKey, noteKey, active, disabled, onSelect }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className={`theme-option${active ? ' active' : ''}`}
      onClick={disabled ? undefined : () => onSelect(id)}
      disabled={disabled}
      aria-pressed={active}
    >
      <span className={`theme-swatch ${SWATCH[id]}`} aria-hidden="true">
        <span /><span /><span /><span />
      </span>
      <span className="theme-option-name">{t(labelKey)}</span>
      <span className="theme-option-note">{t(noteKey)}</span>
    </button>
  );
}

export default function Appearance() {
  const { t } = useTranslation();

  // Two pieces of state for two genuinely different questions:
  //   `mode`  — what the user PREFERS (survives a paid theme being on)
  //   `theme` — what is actually RESOLVED (a lapsed supporter shows free)
  const [mode, setMode] = useState(() => preferredMode());
  const [theme, setTheme] = useState(() => activeTheme());
  const [entitled, setEntitled] = useState(() => isEntitled());

  // Entitlement can resolve after this mounts — SupporterBlock refreshes it
  // on the same screen — so re-read on the event rather than only at mount.
  // Without this the supporter rows stay disabled until a remount, which on
  // the Settings screen means until the user navigates away and back.
  useEffect(() => {
    const reread = () => {
      setEntitled(isEntitled());
      setTheme(activeTheme());
    };
    window.addEventListener('studydesk-entitlement-change', reread);
    return () => window.removeEventListener('studydesk-entitlement-change', reread);
  }, []);

  const chooseMode = useCallback((next) => {
    setPreferredMode(next);
    setMode(next);
  }, []);

  const chooseTheme = useCallback((next) => {
    setPreferredTheme(next);
    setTheme(activeTheme());
    // The mode preference is untouched by the write above, but the RESOLVED
    // mode changes when a paid theme goes on or off, so re-read it for the
    // active-state highlight in the lighting row.
    setMode(preferredMode());
  }, []);

  const paidActive = isPaidTheme(theme);

  return (
    <div className="sv2-section">
      <div className="sv2-section-title">{t('appearance.title')}</div>

      {/* ── Lighting ── */}
      <div className="theme-group">
        <div className="theme-group-label">{t('appearance.lighting')}</div>
        <div className="theme-options">
          {MODES.map((id) => (
            <Option
              key={id}
              id={id}
              labelKey={`appearance.mode.${id}`}
              noteKey={`appearance.modeNote.${id}`}
              // Highlight the PREFERENCE, not the resolved value. While Slate
              // is on, the resolved mode is 'light' for everything, and
              // showing Light as selected would misreport what turning Slate
              // off is about to give back.
              active={mode === id}
              disabled={false}
              onSelect={chooseMode}
            />
          ))}
        </div>
        {paidActive && (
          <div className="theme-locked-note">{t('appearance.lightingInThemeNote')}</div>
        )}
      </div>

      {/* ── Character ── */}
      <div className="theme-group">
        <div className="theme-group-label">{t('appearance.character')}</div>
        <div className="theme-options">
          {THEMES.map((id) => (
            <Option
              key={id}
              id={id}
              labelKey={`appearance.theme.${id}`}
              noteKey={
                isPaidTheme(id) && !entitled
                  ? 'appearance.themeNote.locked'
                  : `appearance.themeNote.${id}`
              }
              active={theme === id}
              // A lapsed or never-supporter can see the themes and cannot
              // apply them. Disabled rather than hidden: the perk has to be
              // visible to be a reason to support.
              disabled={isPaidTheme(id) && !entitled}
              onSelect={chooseTheme}
            />
          ))}
        </div>
        <div className="theme-character-note">{t('appearance.characterNote')}</div>
        {!entitled && (
          <div className="theme-locked-note">{t('appearance.lockedNote')}</div>
        )}
      </div>
    </div>
  );
}
