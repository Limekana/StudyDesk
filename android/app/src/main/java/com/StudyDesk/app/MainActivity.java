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
        super.onCreate(savedInstanceState);
    }
}
