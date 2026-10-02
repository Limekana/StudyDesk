// v1.16 (limecore#16) — opt-in, self-hosted error reports. A port of NCC's
// src/lib/errorReports.ts; the rules are the privacy policy's (NCC#50):
//   - Off until the user switches it on (Settings), or sends ONE report from
//     the crash screen (a one-time consent, ACRA-style).
//   - Accounts only. A guest never sends anything, which keeps "without an
//     account nothing you enter leaves your device" true.
//   - Sent to our own Supabase table (`client_errors`), never a third party.
//   - A technical description only: app, version, platform, Android/browser
//     version, error name, message, stack, screen, time. Never app state or
//     anything the user entered. Messages are cut to 500 characters with
//     anything that looks like an email address or a long number stripped;
//     the stack keeps code frames only, cut to 4,000. The server enforces the
//     same limits.
//   - The same error is sent once per session (by fingerprint), and the
//     server caps each account at 50 a day.
//
// Everything here is best-effort and silent: a failure to report an error
// must never become a second error.
import { useSyncExternalStore } from 'react';
import { Capacitor } from '@capacitor/core';
import { supabase } from './supabase.js';
import { IS_DESKTOP } from './desktop.js';
import pkg from '../../package.json';

const APP = 'studydesk';
const KEY = 'sd-error-reports'; // 'on' enables; anything else (or nothing) is off
export const MESSAGE_MAX = 500;
export const STACK_MAX = 4000;

// ── Consent, device-local and shared by Settings and the crash screen ──────
function readEnabled() {
  try { return localStorage.getItem(KEY) === 'on'; } catch { return false; }
}
let enabled = readEnabled();
const listeners = new Set();
export function setErrorReportsEnabled(on) {
  try {
    if (on) localStorage.setItem(KEY, 'on');
    else localStorage.removeItem(KEY);
  } catch { /* the in-memory value still applies for this session */ }
  enabled = on;
  listeners.forEach((l) => l());
}
export function errorReportsEnabled() {
  return enabled;
}
export function useErrorReportsEnabled() {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => enabled,
    () => enabled,
  );
}

// ── Where the user is ─────────────────────────────────────────────────────
// StudyDesk has no URL router: the view lives in reducer state. App.jsx tells
// this module which view is open, so a report can say where it happened.
let currentView = null;
export function setReportScreen(view) {
  currentView = typeof view === 'string' ? view.slice(0, 200) : null;
}

// ── Building a report ─────────────────────────────────────────────────────
/** Strip what could identify a person, then cut to length. */
export function scrub(text, max) {
  return String(text)
    .replace(/[^\s@<>()"']+@[^\s@<>()"']+\.[a-z]{2,}/gi, '[email]')
    .replace(/\d{6,}/g, '[number]')
    .slice(0, max);
}

/** A stack line that points into code: V8's "at …" or Firefox/Safari's
 *  "fn@url:line:col". A message line is never one, even when it contains an
 *  email address — it has spaces before the "@", a frame does not. */
function isFrame(line) {
  return /^\s*at\s/.test(line) || /^[^\s@]*@\S+:\d+(:\d+)?\s*$/.test(line);
}

/** The first stack line that points into code, trimmed, bundle query dropped. */
function firstFrame(stack) {
  const line = stack.split('\n').map((l) => l.trim()).find(isFrame) ?? '';
  return line.replace(/\?[^:)\s]*/g, '').slice(0, 150);
}

export function currentScreen() {
  return currentView || '/';
}

/** A compact OS + engine string from the user agent, e.g. "Android 14 · Chrome/128". */
export function osVersion(ua = globalThis.navigator?.userAgent ?? '') {
  // In priority order, not leftmost match: an Android UA says "Linux; Android 14".
  const os = [/Android [\d.]+/, /Windows NT [\d.]+/, /Mac OS X [\d_.]+/, /iPhone OS [\d_]+/, /CrOS [\w.]+/, /Linux/]
    .map((re) => ua.match(re)?.[0])
    .find(Boolean);
  const engine = ua.match(/Electron\/\d+|Chrome\/\d+|Firefox\/\d+|Version\/[\d.]+ Safari/)?.[0];
  return [os, engine].filter(Boolean).join(' · ').slice(0, 120);
}

export function buildReport(error, screen = currentScreen()) {
  const e = error instanceof Error ? error : new Error(typeof error === 'string' ? error : 'Non-Error thrown');
  const name = (e.name || 'Error').slice(0, 120);
  const message = scrub(e.message || '', MESSAGE_MAX);
  // V8 opens the stack with "Name: message", which is user-facing text; the
  // message is stored (scrubbed) on its own, so the stack keeps frames only.
  const frames = (e.stack || '').split('\n').filter(isFrame).join('\n');
  return {
    app: APP,
    app_version: pkg.version,
    platform: IS_DESKTOP ? 'desktop' : Capacitor.getPlatform(),
    os_version: osVersion(),
    error_name: name,
    message,
    stack: scrub(frames, STACK_MAX),
    screen,
    fingerprint: `${name}@${firstFrame(frames) || message.slice(0, 60)}`.slice(0, 200),
  };
}

// ── Sending ───────────────────────────────────────────────────────────────
const sentThisSession = new Set();

/**
 * Send a report if allowed. `consent: true` is the crash screen's one-time
 * "Send this report", which does not need the Settings switch. Resolves to
 * 'sent' | 'off' | 'guest' | 'duplicate' | 'failed'. Never throws.
 */
export async function sendReport(report, { consent = false } = {}) {
  try {
    if (!consent && !enabled) return 'off';
    if (sentThisSession.has(report.fingerprint)) return 'duplicate';
    const { data } = await supabase.auth.getSession();
    if (!data?.session?.user) return 'guest';
    sentThisSession.add(report.fingerprint);
    // user_id is not sent: the column defaults to auth.uid() server-side.
    const { error } = await supabase.from('client_errors').insert(report);
    if (error) {
      sentThisSession.delete(report.fingerprint);
      return 'failed';
    }
    return 'sent';
  } catch {
    sentThisSession.delete(report.fingerprint);
    return 'failed';
  }
}

/**
 * Report uncaught errors and unhandled rejections — the ones no error
 * boundary sees (event handlers, timers, promises). Only while the switch is
 * on; the listeners are cheap no-ops otherwise. Returns an uninstaller.
 */
export function installGlobalErrorHandlers(target = window) {
  const onError = (ev) => {
    if (!enabled) return;
    void sendReport(buildReport(ev.error ?? ev.message));
  };
  const onRejection = (ev) => {
    if (!enabled) return;
    void sendReport(buildReport(ev.reason));
  };
  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onRejection);
  return () => {
    target.removeEventListener('error', onError);
    target.removeEventListener('unhandledrejection', onRejection);
  };
}

/** Test-only. */
export function resetErrorReportsForTests() {
  sentThisSession.clear();
  enabled = readEnabled();
  currentView = null;
}
