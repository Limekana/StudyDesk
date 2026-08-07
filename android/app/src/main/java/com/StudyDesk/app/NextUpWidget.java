package com.StudyDesk.app;

// v1.9 (Item 8) — "Next Up" home-screen widget.
//
// Mirrors the single most important thing the app decides: what to do next.
// One line, glanceable, tap to open.
//
// Built on RemoteViews rather than Jetpack Glance. Glance is Google's current
// recommendation and would be the default choice for a greenfield app, but it
// requires the Kotlin Gradle plugin plus the Compose compiler, and this build is
// F-Droid reproducible-verified — a state that took three rounds of work to
// reach. Two widgets showing a few lines of text do not need a Compose runtime,
// and adding one would put that reproducibility at risk for no user-visible
// gain. If a future widget genuinely needs Compose-level layout, that is the
// moment to weigh the toolchain change, with the MRs merged and out of the way.

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.view.View;
import android.widget.RemoteViews;

public class NextUpWidget extends AppWidgetProvider {

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        for (int id : ids) {
            manager.updateAppWidget(id, build(context));
        }
    }

    /** Redraw every placed instance. Called by the bridge when data changes. */
    static void refreshAll(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        int[] ids = manager.getAppWidgetIds(new ComponentName(context, NextUpWidget.class));
        for (int id : ids) {
            manager.updateAppWidget(id, build(context));
        }
    }

    private static RemoteViews build(Context context) {
        WidgetSnapshot snap = WidgetSnapshot.load(context);
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_next_up);

        if (snap.hasNextUp()) {
            views.setViewVisibility(R.id.next_up_title, View.VISIBLE);
            views.setViewVisibility(R.id.next_up_subtitle, View.VISIBLE);
            views.setViewVisibility(R.id.next_up_dot, View.VISIBLE);
            views.setViewVisibility(R.id.next_up_empty, View.GONE);
            views.setTextViewText(R.id.next_up_title, snap.nextUpTitle);
            views.setTextViewText(R.id.next_up_subtitle, snap.nextUpSubtitle);
            views.setImageViewResource(R.id.next_up_dot, WidgetSnapshot.dotFor(snap.nextUpUrgency));
        } else {
            // Empty is a real state, not an error: nothing due is good news, and
            // it is also what a fresh install shows before the app has run once.
            views.setViewVisibility(R.id.next_up_title, View.GONE);
            views.setViewVisibility(R.id.next_up_subtitle, View.GONE);
            // No item means nothing to be urgent about — the dot would be
            // asserting a state that does not exist.
            views.setViewVisibility(R.id.next_up_dot, View.GONE);
            views.setViewVisibility(R.id.next_up_empty, View.VISIBLE);
        }

        // "actions" is the Next Up view — the same question this widget answers,
        // so the tap continues the thought rather than dropping the user on
        // whatever screen they happened to leave the app on.
        views.setOnClickPendingIntent(R.id.next_up_root,
            WidgetOpen.intent(context, "actions", WidgetOpen.REQUEST_NEXT_UP));
        return views;
    }
}
