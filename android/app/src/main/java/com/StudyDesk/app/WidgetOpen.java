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

    static PendingIntent intent(Context context) {
        Intent launch = new Intent(context, MainActivity.class);
        // Reuse the existing task rather than stacking a second copy of the app
        // when the user taps the widget while StudyDesk is already open.
        launch.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);

        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            // IMMUTABLE because nothing needs to fill anything in — the widget
            // always opens the same screen. Required from API 31; safe from 23.
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        return PendingIntent.getActivity(context, 0, launch, flags);
    }
}
