package com.StudyDesk.app;

// v1.9 (Item 8) — the data the home-screen widgets draw from.
//
// The widgets cannot read StudyDesk's own data. It lives in IndexedDB inside
// the WebView, which only exists while the app is running; a widget is drawn by
// the launcher process, often with the app long since killed. So the JS layer
// pushes a small snapshot out to SharedPreferences whenever the data changes
// (see WidgetBridgePlugin), and the widgets read only that.
//
// The consequence is worth stating plainly: a widget is as fresh as the last
// time the app was open. For assignments and exams — things with due dates days
// away, edited a few times a week — that is the right trade. The alternative is
// a background service polling Supabase, which costs battery and a foreground
// notification on modern Android to show data that barely moves.
//
// Stored as one JSON string rather than a spread of typed preference keys, so
// adding a field to the snapshot never needs a migration on the native side.

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

final class WidgetSnapshot {

    static final String PREFS = "studydesk_widget";
    static final String KEY_JSON = "snapshot";

    /** One upcoming item: an assignment due, or an exam. */
    static final class Item {
        final String title;
        final String when;
        /** "assignment" | "exam". Carried but not currently drawn. */
        final String kind;
        /** "urgent" | "soon" | "later" — v1.10, picks the dot. */
        final String urgency;

        Item(String title, String when, String kind, String urgency) {
            this.title = title;
            this.when = when;
            this.kind = kind;
            this.urgency = urgency;
        }
    }

    /**
     * Dot for an urgency string.
     *
     * Anything unrecognised falls back to the calm one. A snapshot written by
     * an older app version has no urgency field at all — that happens on every
     * install that updates the APK without reopening the app, and it should
     * look understated rather than alarm the user in red.
     */
    static int dotFor(String urgency) {
        if ("urgent".equals(urgency)) return R.drawable.widget_dot_urgent;
        if ("soon".equals(urgency)) return R.drawable.widget_dot_soon;
        return R.drawable.widget_dot_later;
    }

    final String nextUpTitle;
    final String nextUpSubtitle;
    final String nextUpUrgency;
    final Item[] upcoming;

    private WidgetSnapshot(String nextUpTitle, String nextUpSubtitle, String nextUpUrgency,
                           Item[] upcoming) {
        this.nextUpTitle = nextUpTitle;
        this.nextUpSubtitle = nextUpSubtitle;
        this.nextUpUrgency = nextUpUrgency;
        this.upcoming = upcoming;
    }

    /**
     * Read the last snapshot the app wrote.
     *
     * Never throws and never returns null: a widget that cannot parse its data
     * still has to draw something, and an empty snapshot renders as the
     * "nothing due" state — which is also exactly what a fresh install shows
     * before the app has ever run.
     */
    static WidgetSnapshot load(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String raw = prefs.getString(KEY_JSON, null);
        if (raw == null) return empty();
        try {
            JSONObject root = new JSONObject(raw);
            JSONObject next = root.optJSONObject("nextUp");
            String title = next == null ? "" : next.optString("title", "");
            String subtitle = next == null ? "" : next.optString("subtitle", "");
            String urgency = next == null ? "later" : next.optString("urgency", "later");

            JSONArray arr = root.optJSONArray("upcoming");
            int n = arr == null ? 0 : arr.length();
            Item[] items = new Item[n];
            for (int i = 0; i < n; i++) {
                JSONObject o = arr.optJSONObject(i);
                items[i] = new Item(
                    o == null ? "" : o.optString("title", ""),
                    o == null ? "" : o.optString("when", ""),
                    o == null ? "assignment" : o.optString("kind", "assignment"),
                    o == null ? "later" : o.optString("urgency", "later")
                );
            }
            return new WidgetSnapshot(title, subtitle, urgency, items);
        } catch (Exception e) {
            // Corrupt or half-written JSON. Draw the empty state rather than
            // letting the launcher show a crashed-widget placeholder.
            return empty();
        }
    }

    static WidgetSnapshot empty() {
        return new WidgetSnapshot("", "", "later", new Item[0]);
    }

    boolean hasNextUp() {
        return nextUpTitle != null && nextUpTitle.length() > 0;
    }
}
