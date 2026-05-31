package com.StudyDesk.app;

// v1.4 cross-app SSO consumer (sister-app side). Identical to LimeLog's
// SuiteSsoPlugin — different package only.
//
// See com.limecore.workouttracker.SuiteSsoPlugin for the full design
// rationale + provider URI + return-shape contract.

import android.content.ContentResolver;
import android.database.Cursor;
import android.net.Uri;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "SuiteSso")
public class SuiteSsoPlugin extends Plugin {

    private static final Uri SESSION_URI =
        Uri.parse("content://com.limecore.nexus.session/current");

    private static final String COL_BUNDLE = "session_bundle_json";
    private static final String COL_PUBLISHED_AT = "published_at";

    @PluginMethod
    public void getNexusSession(PluginCall call) {
        JSObject result = new JSObject();
        ContentResolver resolver = getContext().getContentResolver();
        Cursor cursor = null;
        try {
            cursor = resolver.query(SESSION_URI, null, null, null, null);
            if (cursor == null) {
                result.put("available", false);
                result.put("reason", "Nexus Command Center not reachable (not installed, or different signing cert).");
                call.resolve(result);
                return;
            }
            if (!cursor.moveToFirst()) {
                result.put("available", false);
                result.put("reason", "Sign in to Nexus Command Center first.");
                call.resolve(result);
                return;
            }
            int bundleIdx = cursor.getColumnIndex(COL_BUNDLE);
            int publishedAtIdx = cursor.getColumnIndex(COL_PUBLISHED_AT);
            String bundleJson = bundleIdx >= 0 ? cursor.getString(bundleIdx) : null;
            long publishedAt = publishedAtIdx >= 0 ? cursor.getLong(publishedAtIdx) : 0L;
            if (bundleJson == null || bundleJson.isEmpty()) {
                result.put("available", false);
                result.put("reason", "Nexus has no active session.");
                call.resolve(result);
                return;
            }
            result.put("available", true);
            result.put("bundleJson", bundleJson);
            result.put("publishedAt", publishedAt);
            call.resolve(result);
        } catch (SecurityException se) {
            result.put("available", false);
            result.put("reason", "Permission denied: signing cert mismatch.");
            call.resolve(result);
        } catch (Exception e) {
            result.put("available", false);
            result.put("reason", "Query failed: " + e.getMessage());
            call.resolve(result);
        } finally {
            if (cursor != null) {
                try { cursor.close(); } catch (Exception ignored) { /* */ }
            }
        }
    }
}
