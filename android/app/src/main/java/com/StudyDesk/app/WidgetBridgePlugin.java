package com.StudyDesk.app;

// v1.9 (Item 8) — the JS → widget bridge.
//
// The web layer owns the data and the "what's next" logic; the widgets only
// draw. This is the one seam between them: JS hands over a finished snapshot,
// this stores it and tells the launcher to redraw. No business logic lives on
// the native side, so Next Up cannot drift into meaning two different things in
// two places.
//
// Modelled on SuiteSsoPlugin, the repo's existing local Capacitor plugin.

import android.content.Context;
import android.content.SharedPreferences;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "WidgetBridge")
public class WidgetBridgePlugin extends Plugin {

    /**
     * Store a snapshot and redraw any placed widgets.
     *
     * Takes the already-serialised JSON string rather than a structured object:
     * the shape is the web layer's to define, and passing it through opaquely
     * means adding a field never needs a matching change here.
     */
    @PluginMethod
    public void setSnapshot(PluginCall call) {
        String json = call.getString("json");
        if (json == null) {
            call.reject("json is required");
            return;
        }
        Context context = getContext();
        SharedPreferences prefs =
            context.getSharedPreferences(WidgetSnapshot.PREFS, Context.MODE_PRIVATE);
        // commit(), not apply(): the very next thing this method does is ask the
        // launcher to redraw, and that read happens in another process. apply()
        // is asynchronous, so the widget could read the previous snapshot and
        // show stale data until something else happened to trigger an update.
        prefs.edit().putString(WidgetSnapshot.KEY_JSON, json).commit();

        NextUpWidget.refreshAll(context);
        UpcomingWidget.refreshAll(context);

        call.resolve();
    }

    /**
     * Whether any widget is actually on a home screen.
     *
     * Lets the web layer skip building a snapshot nobody will look at. Building
     * one is cheap, but it runs on every data mutation, and most users never
     * place a widget at all.
     */
    @PluginMethod
    public void hasWidgets(PluginCall call) {
        Context context = getContext();
        android.appwidget.AppWidgetManager manager =
            android.appwidget.AppWidgetManager.getInstance(context);
        int next = manager.getAppWidgetIds(
            new android.content.ComponentName(context, NextUpWidget.class)).length;
        int upcoming = manager.getAppWidgetIds(
            new android.content.ComponentName(context, UpcomingWidget.class)).length;

        JSObject result = new JSObject();
        result.put("placed", next + upcoming > 0);
        call.resolve(result);
    }
}
