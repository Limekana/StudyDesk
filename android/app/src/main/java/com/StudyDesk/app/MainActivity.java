package com.StudyDesk.app;

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
        super.onCreate(savedInstanceState);
    }
}
