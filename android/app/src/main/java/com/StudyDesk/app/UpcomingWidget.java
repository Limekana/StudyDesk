package com.StudyDesk.app;

// v1.9 (Item 8) — "Upcoming" home-screen widget: what is due, in order.
//
// The companion to NextUp. Next Up answers "what now"; this answers "what is
// coming", which is the question a due-date list is actually for.
//
// Rows are a fixed set of pre-declared views rather than a ListView. A widget
// ListView needs a RemoteViewsService plus an adapter running in a separate
// process, which is a lot of moving parts for what is at most a handful of
// deadlines on a home screen. Fixed rows keep it to one layout file and no
// service, and a widget that lists more than about five items is unreadable at
// home-screen size anyway.

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.view.View;
import android.widget.RemoteViews;

public class UpcomingWidget extends AppWidgetProvider {

    /** Rows declared in widget_upcoming.xml. */
    private static final int[] ROW_IDS = {
        R.id.row_0, R.id.row_1, R.id.row_2, R.id.row_3, R.id.row_4
    };
    private static final int[] TITLE_IDS = {
        R.id.row_0_title, R.id.row_1_title, R.id.row_2_title, R.id.row_3_title, R.id.row_4_title
    };
    private static final int[] WHEN_IDS = {
        R.id.row_0_when, R.id.row_1_when, R.id.row_2_when, R.id.row_3_when, R.id.row_4_when
    };
    /** v1.10 — urgency dots, one per row. */
    private static final int[] DOT_IDS = {
        R.id.row_0_dot, R.id.row_1_dot, R.id.row_2_dot, R.id.row_3_dot, R.id.row_4_dot
    };

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        for (int id : ids) {
            manager.updateAppWidget(id, build(context));
        }
    }

    static void refreshAll(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        int[] ids = manager.getAppWidgetIds(new ComponentName(context, UpcomingWidget.class));
        for (int id : ids) {
            manager.updateAppWidget(id, build(context));
        }
    }

    private static RemoteViews build(Context context) {
        WidgetSnapshot snap = WidgetSnapshot.load(context);
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_upcoming);

        int shown = Math.min(snap.upcoming.length, ROW_IDS.length);
        for (int i = 0; i < ROW_IDS.length; i++) {
            if (i < shown) {
                views.setViewVisibility(ROW_IDS[i], View.VISIBLE);
                views.setTextViewText(TITLE_IDS[i], snap.upcoming[i].title);
                views.setTextViewText(WHEN_IDS[i], snap.upcoming[i].when);
                views.setImageViewResource(DOT_IDS[i], WidgetSnapshot.dotFor(snap.upcoming[i].urgency));
            } else {
                views.setViewVisibility(ROW_IDS[i], View.GONE);
            }
        }
        views.setViewVisibility(R.id.upcoming_empty, shown == 0 ? View.VISIBLE : View.GONE);

        // "plan" surfaces the full list of upcoming work, which is what this
        // widget is a preview of. Same target the notification body-tap uses
        // (BUG-14), so both entry points into "what's due" agree.
        views.setOnClickPendingIntent(R.id.upcoming_root,
            WidgetOpen.intent(context, "plan", WidgetOpen.REQUEST_UPCOMING));
        return views;
    }
}
