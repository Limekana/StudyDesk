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

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

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
        out.put("notifications", true);
        call.resolve(out);
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

        JSObject out = new JSObject();
        out.put("chip", false);
        out.put("pinned", false);

        if (wantChip) {
            try {
                postChip(title, text, endsAt);
                out.put("chip", true);
            } catch (Throwable t) {
                // A refused notification must not take the focus session with
                // it. Lock In is still a focus mode without a status chip.
                out.put("chipError", String.valueOf(t.getMessage()));
            }
        }

        if (wantPin) {
            Boolean pinned = setPinned(true);
            out.put("pinned", Boolean.TRUE.equals(pinned));
            if (pinned == null) out.put("pinError", "startLockTask threw");
        }

        call.resolve(out);
    }

    /** Stop focus mode. Always attempts both halves regardless of which were
     *  started, because a crash mid-session can leave one of them live. */
    @PluginMethod
    public void stop(PluginCall call) {
        JSObject out = new JSObject();
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
