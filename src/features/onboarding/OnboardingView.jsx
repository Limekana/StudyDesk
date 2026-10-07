import { useState } from "react";
import { useTranslation } from "react-i18next";
import { setLanguage, SUPPORTED_LANGS, LANGUAGE_NAMES } from "../../i18n/index.js";
import { useScrollSelectedIntoView } from "../../lib/useScrollSelectedIntoView.js";
import CoursePicker from "../../lib/CoursePicker.jsx";
import { COURSE_COLORS } from "../../lib/courseColors.js";
import { enterSubmit } from "../../lib/imeSubmit.js";

// ── OnboardingView — 4-step first-run wizard (cream-paper design) ─────────────
// Steps: 0 language · 1 welcome · 2 first course · 3 daily reminders.
// Shared chrome — wordmark, tagline, progress ticks — wraps every step's body.
//
// Module scope, not nested inside OnboardingView. Declared in the render body it
// was a fresh component type every render, so React unmounted and remounted the
// whole subtree on each keystroke in the step-2 course-name field. Measured
// before and after: pre-fix the <input> DOM node was replaced on every character
// typed; now it survives. autoFocus re-fired on each remount so focus was never
// visibly lost, which is why this went unnoticed — but replacing the focused
// input mid-edit is the kind of churn that upsets IME composition, and zh / hi /
// ar users compose every character.
function OnboardingShell({ step, tagline, children }) {
  return (
    <div className="ob-wrap">
      <div className="ob-card">
        <div className="ob-pad">
          <div className="ob-wordmark">StudyDesk</div>
          <div className="ob-tagline">{tagline}</div>
          <div className="ob-steps">
            {[0,1,2,3].map(i => (
              <div key={i} className={"ob-step-dot"+(i===step?" active":i<step?" done":"")}/>
            ))}
          </div>
          <div className="ob-step-body" key={step}>{children}</div>
        </div>
      </div>
    </div>
  );
}

export default function OnboardingView({ onComplete }) {
  const { t, i18n } = useTranslation();
  const currentLang = (i18n.language || "en").split("-")[0];
  const langRef = useScrollSelectedIntoView();
  const [step, setStep] = useState(0);
  const [courseName, setCourseName] = useState("");
  const [courseColor, setCourseColor] = useState(COURSE_COLORS[0]);

  const chosenColor = courseColor;
  const result = () => courseName.trim() ? { name: courseName.trim(), color: chosenColor } : null;


  if (step === 0) return (
    <OnboardingShell step={step} tagline={t('sdob.brand')}>
      <div className="ob-step-title">{t('sdob.langTitle')}</div>
      <div className="ob-step-desc">{t('sdob.langBody')}</div>
      <div className="ob-langs" ref={langRef}>
        {SUPPORTED_LANGS.map((code)=>(
          <button key={code} className={"ob-lang"+(currentLang===code?" on":"")}
            onClick={()=>setLanguage(code)} aria-pressed={currentLang===code}>
            {LANGUAGE_NAMES[code]}
          </button>
        ))}
      </div>
      <button className="btn" style={{width:"100%",padding:"13px",marginTop:16}} onClick={()=>setStep(1)}>
        {t('sdob.continue')} <span className="rtl-mirror" aria-hidden>→</span>
      </button>
    </OnboardingShell>
  );

  if (step === 1) return (
    <OnboardingShell step={step} tagline={t('sdob.brand')}>
      <div className="ob-step-title">{t('sdob.welcomeTitle')}</div>
      <div className="ob-step-desc">{t('sdob.welcomeBody')}</div>
      <button className="btn" style={{width:"100%",padding:"13px"}} onClick={()=>setStep(2)}>
        {t('sdob.getStarted')} <span className="rtl-mirror" aria-hidden>→</span>
      </button>
    </OnboardingShell>
  );

  if (step === 2) return (
    <OnboardingShell step={step} tagline={t('sdob.brand')}>
      <div className="ob-step-title">{t('sdob.courseTitle')}</div>
      <div className="ob-step-desc">{t('sdob.courseBody')}</div>
      <div className="input-group">
        <div className="input-label">{t('sdob.courseNameLabel')}</div>
        <input type="text" placeholder={t('sdob.coursePlaceholder')}
          value={courseName} onChange={e=>setCourseName(e.target.value)}
          {...enterSubmit(()=>courseName.trim()&&setStep(3))}
          autoFocus/>
      </div>
      <div className="input-group">
        <div className="input-label">{t('sdob.colorLabel')}</div>
        <CoursePicker value={courseColor} onChange={setCourseColor}/>
      </div>
      <button className="btn" style={{width:"100%",padding:"13px",marginTop:8}}
        onClick={()=>{ if(courseName.trim()) setStep(3); }}>
        {t('sdob.continue')} <span className="rtl-mirror" aria-hidden>→</span>
      </button>
      <div className="ob-skip" onClick={()=>setStep(3)}>{t('sdob.skip')}</div>
    </OnboardingShell>
  );

  if (step === 3) return (
    <OnboardingShell step={step} tagline={t('sdob.brand')}>
      <div className="ob-notif-box">
        <div className="ob-notif-icon">🔔</div>
        <div className="ob-notif-title">{t('sdob.notifTitle')}</div>
        <div className="ob-notif-desc">{t('sdob.notifBody')}</div>
      </div>
      {/* These two buttons were wired to the identical handler, so "Maybe
          later" completed onboarding exactly like "Enable reminders" and the
          OS permission prompt fired either way. The choice now travels with
          the completion. */}
      <button className="btn" style={{width:"100%",padding:"13px",marginBottom:10}} onClick={()=>onComplete(result(), { notifications: true })}>
        {t('sdob.enableReminders')}
      </button>
      <button className="btn-outline" style={{width:"100%",padding:"11px"}} onClick={()=>onComplete(result(), { notifications: false })}>
        {t('sdob.maybeLater')}
      </button>
    </OnboardingShell>
  );

  return null;
}
