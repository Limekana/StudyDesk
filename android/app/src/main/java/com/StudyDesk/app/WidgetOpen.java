package com.StudyDesk.app;

// v1.9 (Item 8) — the tap target both widgets share.
//
// Split out so the PendingIntent is built one way in one place. Getting the
// flags wrong here is a crash on Android 12+, not a cosmetic bug: targeting
// S or later with a PendingIntent that is neither IMMUTABLE nor MUTABLE throws
// at construction time.

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

final class WidgetOpen {

    private WidgetOpen() {}

    /** Distinct per target — see the requestCode note in {@link #intent}. */
    static final int REQUEST_NEXT_UP = 1;
    static final int REQUEST_UPCOMING = 2;

    /**
     * Build the tap target for a widget.
     *
     * @param view        the web layer's view id to land on ("actions", "plan")
     * @param requestCode must differ per target — this is load-bearing, not a
     *                    formality. PendingIntent identity is decided by
     *                    Intent.filterEquals(), which compares action, data,
     *                    type, package, component and categories — and
     *                    deliberately ignores extras. Two widgets pointing at
     *                    the same component therefore look identical to the
     *                    system, so a shared requestCode would hand both the
     *                    same PendingIntent, and FLAG_UPDATE_CURRENT would
     *                    quietly overwrite the first one's extras with the
     *                    second's. Both widgets would then open whichever view
     *                    was drawn last.
     */
    static PendingIntent intent(Context context, String view, int requestCode) {
        Intent launch = new Intent(context, MainActivity.class);
        // Reuse the existing task rather than stacking a second copy of the app
        // when the user taps the widget while StudyDesk is already open.
        launch.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        launch.putExtra(WidgetBridgePlugin.EXTRA_VIEW, view);

        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            // IMMUTABLE because nothing downstream fills anything in — the view
            // is baked in here. Required from API 31; safe from 23.
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        return PendingIntent.getActivity(context, requestCode, launch, flags);
    }
}
