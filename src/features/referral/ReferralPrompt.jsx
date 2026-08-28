import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { REFERRAL_OPTIONS, REFERRAL_DISMISSED, recordReferralSource, shouldAskReferral } from "../../lib/referralSource.js";

// Item 8 — asks once, ever, then gets out of the way. See referralSource.js
// for why this is self-reported and why it lives in auth metadata.
//
// Deliberately NOT a modal. This fires on a brand-new user's first real
// session, which is precisely the moment activation is decided; a blocking
// overlay demanding an answer before the app can be used would damage the
// number it exists to measure. It is a corner card that can be ignored
// outright — ignoring it still counts as dismissal once the card is closed.
export default function ReferralPrompt({ user }) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (!shouldAskReferral(user)) return;
    // Short beat before appearing. On a fresh signup this mounts the instant
    // onboarding finishes, and sliding a question in over the top of the
    // completion frame reads as a second onboarding step rather than an
    // aside — which is exactly what would make people answer at random.
    const id = setTimeout(() => setVisible(true), 1200);
    return () => clearTimeout(id);
  }, [user]);

  if (!visible) return null;

  const answer = (source) => {
    recordReferralSource(user, source);
    // Leave the acknowledgement on screen briefly so the tap has a result;
    // `closing` also disables the buttons, so a double-tap cannot fire a
    // second write against the now-stale `hasReferralSource` read.
    setClosing(true);
    setTimeout(() => setVisible(false), 900);
  };

  return (
    <div className="ref-card" role="dialog" aria-live="polite" aria-label={t("referral.title")}>
      {closing ? (
        <div className="ref-thanks">{t("referral.thanks")}</div>
      ) : (
        <>
          <div className="ref-eyebrow">{t("referral.eyebrow")}</div>
          <div className="ref-title">{t("referral.title")}</div>
          <div className="ref-options">
            {REFERRAL_OPTIONS.map((key) => (
              <button key={key} type="button" className="ref-option" onClick={() => answer(key)}>
                {t(`referral.opt.${key}`)}
              </button>
            ))}
          </div>
          <button type="button" className="ref-dismiss" onClick={() => answer(REFERRAL_DISMISSED)}>
            {t("referral.dismiss")}
          </button>
        </>
      )}
    </div>
  );
}
