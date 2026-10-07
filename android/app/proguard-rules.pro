# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# ── v1.17 (limecore#19): R8 is on for release builds ───────────────────────
#
# What already keeps the code R8 cannot see being used:
#   - Capacitor's consumer rules (node_modules/@capacitor/android/capacitor/
#     proguard-rules.pro) keep every class extending com.getcapacitor.Plugin,
#     with all its members. That covers this app's own plugins and every npm
#     plugin, which Capacitor finds by class name and calls by reflection.
#   - AAPT keeps every component AndroidManifest.xml names (activities,
#     receivers, providers, widgets).
#   - The optimize defaults keep @JavascriptInterface methods, which is how
#     the WebView reaches the bridge.
# That is not enough on its own: Capacitor also reads its annotations at
# runtime, which needs the rules at the end of this file.

# Native stack traces stay mappable: line numbers are kept, and the release's
# mapping.txt turns the obfuscated names back.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# Capacitor reads its own annotations at runtime: @CapacitorPlugin (with its
# @Permission list) and @PluginMethod, through reflection in PluginHandle and
# Bridge.getPermissionStates(). In full mode R8 treats an annotation type that
# no rule keeps as having no instances, so the stored @CapacitorPlugin came back
# null and LocalNotifications.requestPermissions() crashed the app on launch
# (emulator, 2026-10-05). Keep the annotation types, their values and defaults.
-keepattributes RuntimeVisibleAnnotations,RuntimeVisibleParameterAnnotations,AnnotationDefault
-keep @interface com.getcapacitor.annotation.** { *; }
-keep @interface com.getcapacitor.PluginMethod { *; }
-keep @interface com.getcapacitor.NativePlugin { *; }
