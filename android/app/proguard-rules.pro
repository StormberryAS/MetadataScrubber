# R8 is on for release, and these are the reasons it is safe.
#
# 1. Nothing in this app is reached by reflection or from JavaScript by name. The page
#    talks to Kotlin through WebViewCompat.addWebMessageListener: the WebView injects a
#    `MSBridge` object whose only method is postMessage, and messages arrive in an
#    ordinary Kotlin callback. There is no @JavascriptInterface class, which is the usual
#    thing R8 strips from WebView apps.
# 2. androidx.webkit reaches the WebView APK through its support-library boundary
#    interfaces, and ships consumer rules that keep them. androidx.core ships the rules for
#    FileProvider, which the manifest names. AGP keeps every class the manifest names.
# 3. The web app itself is in assets/, which R8 never touches.
#
# Obfuscation is off so stack traces from users stay readable; shrinking and
# optimisation still apply.
-dontobfuscate
