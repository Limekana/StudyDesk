package com.StudyDesk.app;

import android.content.Intent;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // v1.4 — register the SuiteSso plugin so the JS layer can query
        // NCC's SessionContentProvider for shared sign-in. See LimeLog's
        // MainActivity for the design rationale.
        registerPlugin(SuiteSsoPlugin.class);
        // v1.9 (Item 8) — lets the web layer push a snapshot out to the
        // home-screen widgets. Registered before super.onCreate for the same
        // reason as above: the bridge reads the plugin list during it.
        registerPlugin(WidgetBridgePlugin.class);
        // v1.10 (Item 12) — Lock In's native half: the ongoing focus chip and
        // screen pinning, each behind its own setting.
        registerPlugin(FocusModePlugin.class);

        // Must run BEFORE super.onCreate(): that call builds the bridge and so
        // publishes the plugin instance, which is what stashLaunchView() uses
        // to decide between queueing the tap and emitting it as an event. On a
        // cold start there is no JS listener yet, so it has to queue — and it
        // only queues while the instance is still null.
        WidgetBridgePlugin.stashLaunchView(getIntent());

        super.onCreate(savedInstanceState);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // singleTask: a widget tap while StudyDesk is already open is delivered
        // here rather than through onCreate. setIntent so getIntent() reflects
        // what actually brought the activity forward.
        setIntent(intent);
        WidgetBridgePlugin.stashLaunchView(intent);
    }
}
