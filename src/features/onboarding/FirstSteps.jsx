// v1.14 — the inline next-step strip. See src/lib/firstSteps.js for why this
// is three dismissible suggestions rather than a wizard, and for the rule
// that stops it nagging anyone who is past being new.

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { outstandingSteps, readDismissed, dismissStep } from '../../lib/firstSteps.js';

/**
 * @param {object} state the app state — the strip is a claim about the user's
 *        data, so it is recomputed on every render rather than snapshotted:
 *        finishing a step has to remove its card without a reload.
 * @param {(step: string) => void} onGo  navigation is the caller's business.
 *        This component knows which steps are outstanding; App knows that the
 *        timetable is a sub-tab of Plan, which is not a fact worth teaching
 *        to three other files.
 */
export default function FirstSteps({ state, onGo }) {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState(readDismissed);
  const steps = outstandingSteps(state, dismissed);
  if (steps.length === 0) return null;

  return (
    <div className="fs-strip">
      <div className="fs-title">{t('firstSteps.title')}</div>
      {steps.map((step) => (
        <div key={step} className="fs-card">
          <div className="fs-card-body">
            <div className="fs-card-title">{t(`firstSteps.${step}Title`)}</div>
            <div className="fs-card-sub">{t(`firstSteps.${step}Sub`)}</div>
          </div>
          <div className="fs-card-actions">
            <button className="btn btn-sm" onClick={() => onGo?.(step)}>
              {t(`firstSteps.${step}Cta`)}
            </button>
            <button
              className="fs-skip"
              onClick={() => setDismissed(dismissStep(step, dismissed))}
              // "Not now" would promise it comes back. It does not — this is
              // permanent, and the label says the thing it does.
              aria-label={t('firstSteps.dismissAria', { what: t(`firstSteps.${step}Title`) })}
            >
              {t('firstSteps.dismiss')}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
