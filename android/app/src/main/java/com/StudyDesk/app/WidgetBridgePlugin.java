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
import android.content.Intent;
import android.content.SharedPreferences;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "WidgetBridge")
public class WidgetBridgePlugin extends Plugin {

    /** Intent extra carrying the web layer's view id for a widget tap. */
    static final String EXTRA_VIEW = "sd_widget_view";

    /** Live plugin instance, or null before the bridge has built one. */
    private static WidgetBridgePlugin instance;

    /** A tap that arrived with no JS listening yet. Collected on mount. */
    private static String pendingView;

    @Override
    public void load() {
        instance = this;
    }

    /**
     * Take the target view off a launch intent, if it carries one.
     *
     * Two arrival paths, and they need different handling:
     *
     * - Cold start. MainActivity calls this *before* super.onCreate(), so the
     *   bridge does not exist and neither does any JS listener. The view is
     *   queued in pendingView for consumeLaunchView() to collect once the web
     *   layer mounts. Emitting an event here would fire into an empty room.
     * - Warm start. The activity is singleTask, so a tap on a widget while
     *   StudyDesk is already running arrives at onNewIntent with JS live and
     *   listening. Deliver it as an event; nothing will call consume() again.
     *
     * Exactly one of the two paths handles any given tap, which is why the
     * event path clears pendingView rather than also queueing: a queued value
     * nobody collects would resurface on the next mount and navigate the user
     * somewhere they did not ask to go.
     */
    static void stashLaunchView(Intent intent) {
        if (intent == null) return;
        String view = intent.getStringExtra(EXTRA_VIEW);
        if (view == null) return;

        // Consume it off the intent. getIntent() keeps returning the launch
        // intent for the life of the activity, so leaving the extra in place
        // would re-navigate on every configuration change.
        intent.removeExtra(EXTRA_VIEW);

        if (instance != null) {
            pendingView = null;
            JSObject payload = new JSObject();
            payload.put("view", view);
            instance.notifyListeners("widgetNavigate", payload);
        } else {
            pendingView = view;
        }
    }

    /**
     * Collect a queued cold-start tap, if there was one.
     *
     * Returns {view: null} on a normal launch — the common case by far, since
     * most launches are from the app icon.
     */
    @PluginMethod
    public void consumeLaunchView(PluginCall call) {
        JSObject result = new JSObject();
        result.put("view", pendingView);
        pendingView = null;
        call.resolve(result);
    }

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
