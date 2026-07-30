// AI study-session debrief — v1.4.
//
// Mirrors LimeLog's post-workout debrief: the user types a free-text note about
// what they studied, and the shared `ai-generate` Supabase Edge Function (cloud
// Gemini) extracts structured fields. StudyDesk and LimeLog share the same
// Supabase project, so this is auth-gated by the user's existing session — the
// debrief only works signed in. Always degrades to null on any failure.

import { supabase } from './supabase.js';

function buildPrompt(userText) {
  return `Extract study session data from this note. Return ONLY valid JSON matching this exact schema — no prose, no markdown fences:
{
  "subjectCovered": <string: main topic studied, 1-5 words>,
  "comprehension": <number 1-5: 1=totally lost, 5=fully understood, or null>,
  "confusionFlags": <string[]: specific concepts mentioned as confusing; empty array if none>,
  "sessionSummary": <string: clean one-sentence summary of what was studied, max 80 chars>
}

Note: "${userText.slice(0, 400).replace(/"/g, "'")}"`;
}

/** Analyse a free-text study note. Returns structured fields, or null on any
 *  failure (not signed in, offline, blocked, unparseable). */
export async function analyseStudySession(userText) {
  const text = (userText || '').trim();
  if (!text) return null;
  // The opt-in gate. `canDebrief` already hides the UI, but this is the one
  // place the note actually leaves the device, so the check belongs here too —
  // a future caller cannot route around the user's choice by forgetting it.
  try {
    if (localStorage.getItem('studydesk-ai-enabled') !== '1') return null;
  } catch {
    return null;
  }
  // Gate on a live session — the Edge Function requires the user's JWT.
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  try {
    const { data, error } = await supabase.functions.invoke('ai-generate', {
      body: { prompt: buildPrompt(text), json: true, maxTokens: 200, temperature: 0.2 },
    });
    if (error || !data?.text) return null;
    return parse(data.text);
  } catch {
    return null;
  }
}

function parse(raw) {
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    // Defensive: pull the first {...} block if the model wrapped it in fences.
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      obj = JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object') return null;

  const subjectCovered =
    typeof obj.subjectCovered === 'string' ? obj.subjectCovered.slice(0, 80) : '';
  const comprehension =
    typeof obj.comprehension === 'number' && obj.comprehension >= 1 && obj.comprehension <= 5
      ? Math.round(obj.comprehension)
      : null;
  const confusionFlags = Array.isArray(obj.confusionFlags)
    ? obj.confusionFlags
        .filter((x) => typeof x === 'string' && x.trim().length > 0)
        .map((x) => x.trim().slice(0, 60))
        .slice(0, 8)
    : [];
  const sessionSummary =
    typeof obj.sessionSummary === 'string' ? obj.sessionSummary.slice(0, 200) : '';

  return { subjectCovered, comprehension, confusionFlags, sessionSummary };
}
