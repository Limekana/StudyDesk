package com.StudyDesk.app;

// v1.10 (Item 12) — the native half of Lock In.
//
// Owner, from the braindump: "Could studydesk timer lock in mode be made to
// restrict other app use and show up in like the samsung now bar if thats what
// its called and whatever equivalents it has for other android phones".
//
// That is two separate asks, and they ship as two independent toggles because
// they fail differently and one is far more intrusive than the other:
//
//   1. A live status chip while a focus block runs.
//   2. Stopping the user leaving the app.
//
// ── On the "Samsung Now Bar" half, plainly ────────────────────────────────
// The Now Bar is NOT a third-party API. There is no Samsung SDK to call and no
// intent to broadcast; on One UI 7 it was closed to apps entirely. What DOES
// reach it is Android 16's Live Updates: an ongoing notification that asks to
// be promoted, which One UI 8 surfaces in the Now Bar and stock Android renders
// as a status-bar chip. So this plugin does not "integrate with the Now Bar" —
// it posts a correctly-shaped promoted ongoing notification and lets each OEM's
// shell decide what to do with it. On a device that does nothing special, the
// result is still a perfectly good ongoing notification with a live countdown,
// which is the "whatever equivalents it has for other android phones" half of
// the ask. Anything stronger would be a claim about Samsung's shell that this
// code cannot make good on.
//
// ── Deliberately NOT a foreground service ─────────────────────────────────
// The countdown is drawn by the system's own chronometer from a wall-clock
// deadline, so nothing of ours needs to be running for it to stay correct
// while the phone is in a pocket. That avoids FOREGROUND_SERVICE, a wake lock,
// and a battery-exemption prompt — three permissions an F-Droid reviewer would
// reasonably ask about, for a feature that is a label and a timer.
//
// ── v1.17 (#68): real fullscreen, the third half ──────────────────────────
// User feedback asked for "a fullscreen Pomodoro timer". Lock In asks the web
// Fullscreen API for it, which works in a desktop browser but not here: the
// WebView accepts the request, but the status and navigation bars stay on
// screen. This hides them natively while Lock In is active, with the swipe-to-peek
// behaviour (a swipe slides the bars in over the timer, and they go away again
// on their own). The bars come back whenever the app is backgrounded or Lock
// In ends by any path, including stop() after a crash.

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.view.Window;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "FocusMode")
public class FocusModePlugin extends Plugin {

    private static final String CHANNEL_ID = "studydesk_focus";
    private static final int NOTIFICATION_ID = 4201;

    /** Whether THIS plugin started the lock task. Screen pinning can also be
     *  started by the user from Recents, and stopping a pin we did not start
     *  would yank the screen out from under them. */
    private boolean pinnedByUs = false;

    /** Whether Lock In currently wants the system bars hidden. Kept apart from
     *  what is on screen, because backgrounding shows the bars while Lock In is
     *  still running, and resuming has to know to hide them again. */
    private boolean immersiveWanted = false;

    /**
     * What this device can actually do, asked before anything is offered.
     *
     * The JS layer uses this to hide toggles rather than to show controls that
     * fail on tap — a settings switch that silently does nothing is worse than
     * an absent one, because the user cannot tell it from a bug.
     */
    @PluginMethod
    public void capabilities(PluginCall call) {
        JSObject out = new JSObject();
        out.put("sdk", Build.VERSION.SDK_INT);
        // Screen pinning is API 21+; every device this app runs on (minSdk 24)
        // has it. It can still be refused at the moment of use, which is why
        // start() reports what actually happened rather than trusting this.
        out.put("pinning", true);
        // Live Updates / promoted ongoing landed in Android 16 (API 36).
        // Below that the notification is still posted, just never promoted.
        out.put("promotedOngoing", Build.VERSION.SDK_INT >= 36);
        // Issue #39. This used to be a hardcoded `true`, which made the whole
        // feature undiagnosable: the settings screen rendered the chip toggle,
        // the user switched it on, and `nm.notify()` was then a silent no-op
        // because the OS had never been granted POST_NOTIFICATIONS. No error,
        // no callback, nothing in logcat — "it has never worked."
        //
        // `areNotificationsEnabled()` is the honest answer and covers both ways
        // it can be off: the runtime permission ungranted on API 33+, and the
        // user disabling notifications for the app in system settings. API 24+,
        // which is this app's minSdk, so no compat shim is needed.
        out.put("notifications", notificationsAllowed());
        call.resolve(out);
    }

    /** Re-read the notification permission. Separate from `capabilities()`
     *  because the JS side caches that for the lifetime of the process — this
     *  is what the settings screen calls after asking for the permission, and
     *  after the user comes back from the system settings app. */
    @PluginMethod
    public void notificationsEnabled(PluginCall call) {
        JSObject out = new JSObject();
        out.put("enabled", notificationsAllowed());
        call.resolve(out);
    }

    private boolean notificationsAllowed() {
        try {
            NotificationManager nm =
                    (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return false;
            return Build.VERSION.SDK_INT < Build.VERSION_CODES.N || nm.areNotificationsEnabled();
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * Start focus mode.
     *
     * `endsAt` is an absolute epoch-millis deadline rather than a duration on
     * purpose: a duration would need us to be alive to count it down, and the
     * whole point is that this survives the app being backgrounded. The system
     * chronometer takes the deadline and does the arithmetic itself.
     */
    @PluginMethod
    public void start(PluginCall call) {
        String title = call.getString("title", "Focus");
        String text = call.getString("text", "");
        long endsAt = call.getLong("endsAt", 0L);
        boolean wantChip = Boolean.TRUE.equals(call.getBoolean("chip", true));
        boolean wantPin = Boolean.TRUE.equals(call.getBoolean("pin", false));
        boolean wantImmersive = Boolean.TRUE.equals(call.getBoolean("immersive", false));

        JSObject out = new JSObject();
        out.put("chip", false);
        out.put("pinned", false);

        // Independent of the other two halves, like they are of each other:
        // the bars hide even with the chip and pinning both switched off.
        immersiveWanted = wantImmersive;
        out.put("immersive", applySystemBars(wantImmersive));

        if (wantChip) {
            // Issue #39: check BEFORE posting. `nm.notify()` does not throw
            // when POST_NOTIFICATIONS is ungranted — it silently drops the
            // notification — so the old try/catch reported `chip: true` for a
            // chip that was never shown. The caller then had no way to tell a
            // working chip from a blocked one, and neither did the user.
            if (!notificationsAllowed()) {
                out.put("chipError", "notifications-blocked");
            } else {
                try {
                    postChip(title, text, endsAt);
                    out.put("chip", true);
                } catch (Throwable t) {
                    // A refused notification must not take the focus session
                    // with it. Lock In is still a focus mode without a chip.
                    out.put("chipError", String.valueOf(t.getMessage()));
                }
            }
        }

        if (wantPin) {
            Boolean pinned = setPinned(true);
            out.put("pinned", Boolean.TRUE.equals(pinned));
            if (pinned == null) out.put("pinError", "startLockTask threw");
        }

        call.resolve(out);
    }

    /** Stop focus mode. Always attempts every half regardless of which were
     *  started, because a crash mid-session can leave one of them live. */
    @PluginMethod
    public void stop(PluginCall call) {
        JSObject out = new JSObject();
        immersiveWanted = false;
        applySystemBars(false);
        try {
            NotificationManager nm =
                    (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.cancel(NOTIFICATION_ID);
            out.put("chipCleared", true);
        } catch (Throwable t) {
            out.put("chipCleared", false);
        }
        setPinned(false);
        out.put("pinned", false);
        call.resolve(out);
    }

    // ── System bars ────────────────────────────────────────────────────────

    // Leaving the app shows the bars even though Lock In is still running:
    // whatever comes up next (the launcher, Recents, another app) gets a normal
    // screen. Coming back hides them again.
    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        if (immersiveWanted) applySystemBars(false);
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        if (immersiveWanted) applySystemBars(true);
    }

    /**
     * Hide or show the status and navigation bars together.
     *
     * TRANSIENT_BARS_BY_SWIPE rather than the default: with the default, a
     * swipe brings the bars back for good and Lock In stops being fullscreen
     * until something hides them again. This way a swipe shows them over the
     * timer for a moment (to check the time, or to reach Back), without
     * resizing the page under them.
     *
     * @return false when there is no activity to apply it to.
     */
    private boolean applySystemBars(boolean hide) {
        final android.app.Activity activity = getActivity();
        if (activity == null) return false;
        getBridge().executeOnMainThread(() -> {
            try {
                Window window = activity.getWindow();
                WindowInsetsControllerCompat controller =
                        WindowCompat.getInsetsController(window, window.getDecorView());
                if (hide) {
                    controller.setSystemBarsBehavior(
                            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                    controller.hide(WindowInsetsCompat.Type.systemBars());
                } else {
                    controller.show(WindowInsetsCompat.Type.systemBars());
                }
            } catch (Throwable ignored) {
                // Bars that won't hide must not take the focus session with
                // them. Lock In still works with the bars on screen.
            }
        });
        return true;
    }

    // ── Notification ───────────────────────────────────────────────────────

    private void postChip(String title, String text, long endsAt) {
        Context ctx = getContext();
        NotificationManager nm =
                (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID, "Focus session", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Shows the running Lock In block.");
            // A focus tool that pings you is self-defeating.
            channel.setSound(null, null);
            channel.enableVibration(false);
            channel.setShowBadge(false);
            nm.createNotificationChannel(channel);
        }

        Intent open = new Intent(ctx, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent contentIntent = PendingIntent.getActivity(
                ctx, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification.Builder b = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                ? new Notification.Builder(ctx, CHANNEL_ID)
                : new Notification.Builder(ctx);

        b.setContentTitle(title)
                .setContentText(text)
                .setSmallIcon(getSmallIcon(ctx))
                .setContentIntent(contentIntent)
                .setOngoing(true)          // not swipeable — it mirrors live state
                .setOnlyAlertOnce(true)
                .setShowWhen(endsAt > 0);

        if (endsAt > 0) {
            // Counting DOWN to the deadline. setWhen carries the deadline and
            // the system renders the remaining time, so the number stays right
            // with no work from us and no drift while backgrounded.
            b.setWhen(endsAt);
            b.setUsesChronometer(true);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                b.setChronometerCountDown(true);
            }
        }

        // Android 16+: ask to be promoted to a Live Update. This is the single
        // line that puts the chip in front of the user on a modern shell — the
        // Now Bar on One UI 8, a status-bar chip on stock. Reflection rather
        // than a direct call so the source still compiles against an older
        // platform jar, and so an OEM that has removed the method degrades to
        // an ordinary ongoing notification instead of crashing the session.
        if (Build.VERSION.SDK_INT >= 36) {
            try {
                Notification.Builder.class
                        .getMethod("requestPromotedOngoing", boolean.class)
                        .invoke(b, true);
            } catch (Throwable ignored) {
                // Not promoted. Still a correct ongoing notification.
            }
        }

        nm.notify(NOTIFICATION_ID, b.build());
    }

    /** The monochrome status icon added in v1.1. Resolved by name so this file
     *  does not depend on the generated R class being regenerated in step. */
    private int getSmallIcon(Context ctx) {
        int id = ctx.getResources().getIdentifier(
                "ic_stat_studydesk", "drawable", ctx.getPackageName());
        return id != 0 ? id : android.R.drawable.ic_lock_idle_lock;
    }

    // ── Screen pinning ─────────────────────────────────────────────────────

    /**
     * @return TRUE pinned, FALSE cleanly not pinned, null if the call threw.
     *
     * Not a device owner, so this is the ordinary user-facing pin: the system
     * shows its own confirmation and the user leaves by holding Back+Recents.
     * We never get to skip that prompt, which is correct — an app that could
     * silently trap someone in itself would be malware, not a study aid.
     */
    private Boolean setPinned(boolean pin) {
        final android.app.Activity activity = getActivity();
        if (activity == null) return Boolean.FALSE;
        final Boolean[] result = new Boolean[] { Boolean.FALSE };
        try {
            // Lock-task calls must run on the UI thread; runOnUiThread executes
            // inline when we are already on it, so this is safe either way.
            activity.runOnUiThread(() -> {
                try {
                    if (pin) {
                        activity.startLockTask();
                        pinnedByUs = true;
                        result[0] = Boolean.TRUE;
                    } else if (pinnedByUs) {
                        activity.stopLockTask();
                        pinnedByUs = false;
                        result[0] = Boolean.FALSE;
                    }
                } catch (Throwable t) {
                    result[0] = null;
                }
            });
        } catch (Throwable t) {
            return null;
        }
        return result[0];
    }
}
