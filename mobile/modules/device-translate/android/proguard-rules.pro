# ML Kit registers its internal components through reflection (manifest metadata, component
# registrars, factories looked up by class). R8 can't see those uses: in a minified release build
# it removed classes in these packages, and Translation.getClient() then failed with a
# NullPointerException inside ML Kit. Keep ML Kit and its component framework intact.
-keep class com.google.mlkit.** { *; }
-keep class com.google.android.gms.internal.mlkit_common.** { *; }
-keep class com.google.android.gms.internal.mlkit_translate.** { *; }
-keep class com.google.firebase.components.** { *; }
