package no.stormberry.metadatascrubber

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContract
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.content.IntentCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import kotlin.io.encoding.Base64

/**
 * One screen: a WebView running the bundled web app, which is the same set of files that
 * metadata.stormberry.as serves. Kotlin adds only what a browser would otherwise provide:
 * the system file picker, Save, Share and Copy for the finished file, and pictures shared
 * in from other apps. The scrubbing itself happens in the page, exactly as on the website.
 *
 * Since 1.0.1 the page's own buttons decide what happens to a finished file, as on the
 * website: Save opens Android's save screen and nothing else, "Share the new image" opens
 * Android's share sheet straight away (the warning stays visible under the button in the
 * page), and Copy image puts the page's fresh PNG on Android's clipboard.
 *
 * Since 1.1.0 the page's "Take a photo" opens the app's own camera screen (CameraActivity)
 * through the bridge. The photo comes back as a UUID, is checked once more (JpegCheck) and
 * handed to the page like a picture shared in, marked as a photo taken in the app; the
 * file in cache/camera/ is deleted as soon as the page has the bytes (CameraFiles).
 */
class MainActivity : ComponentActivity() {

    private lateinit var container: FrameLayout
    private var webView: WebView? = null
    private lateinit var assetLoader: WebViewAssetLoader
    private lateinit var outgoingFiles: OutgoingFiles
    private lateinit var cameraFiles: CameraFiles

    private val main = Handler(Looper.getMainLooper())
    private val io: ExecutorService = Executors.newSingleThreadExecutor()

    private var replyProxy: JavaScriptReplyProxy? = null
    private var bridgeSupported = false

    // File picking for the page's <input type="file">.
    private var pendingChooser: ValueCallback<Array<Uri>>? = null

    // The finished file the user is choosing where to save.
    private var pendingOut: OutFile? = null
    private var outTransfer: OutTransfer? = null

    // The copied picture's 2 minutes (ClipboardFiles) and a shared file's 10 minutes
    // (OutgoingFiles, 1.1.0). The timer tidies up on time while the app runs; the provider
    // refuses an expired copy or shared file whatever happens (OutgoingProvider, ClipExpiry).
    private lateinit var clipFiles: ClipboardFiles
    private val expireClip = Runnable { sweepClips() }
    // The copy the page was told about; when it is gone, the page hears "clip-expired".
    private var pageClip: File? = null

    // Pictures shared into the app, or the photo just taken, waiting for the page to pull them.
    private var nextBatchId = 1
    private var incoming: IncomingBatch? = null

    // The camera screen is open; a second "camera-open" from the page is ignored meanwhile.
    private var cameraPending = false

    // The UUID of a photo just back from the camera screen and still being checked; the
    // sweep of cache/camera/ leaves it alone (sweepCameraFiles).
    private var checkingPhoto: String? = null

    private val pickMany = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        deliverChosen(uris.takeIf { it.isNotEmpty() }?.toTypedArray())
    }
    private val pickOne = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        deliverChosen(uri?.let { arrayOf(it) })
    }
    private val saveDocument = registerForActivityResult(CreateTypedDocument()) { uri -> onSaveTarget(uri) }
    private val takePhoto = registerForActivityResult(TakePhoto()) { id -> onPhotoTaken(id) }

    override fun onCreate(savedInstanceState: Bundle?) {
        val page = ContextCompat.getColor(this, R.color.page_background)
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(page),
            navigationBarStyle = SystemBarStyle.dark(page),
        )
        super.onCreate(savedInstanceState)

        outgoingFiles = OutgoingFiles(cacheDir)
        cameraFiles = CameraFiles(cacheDir)
        clipFiles = ClipboardFiles(cacheDir)
        if (savedInstanceState == null) {
            // A fresh start: whatever an earlier session left in the share cache goes now,
            // except a shared file still within its 10 minutes, which the app it went to may
            // not have read yet (it has its own timer). So does a photo left by a process
            // that never came back to hand it over.
            io.execute {
                outgoingFiles.clearExceptLiveShares()
                cameraFiles.clear()
            }
        } else {
            restorePendingOut(savedInstanceState)
            restoreCameraPhoto(savedInstanceState)
        }

        assetLoader = WebViewAssetLoader.Builder()
            .setDomain(NavigationPolicy.ASSET_HOST)
            .setHttpAllowed(false)
            .addPathHandler("/", WebAssetHandler(assets))
            .build()

        // Debugging the page from a desktop browser is for debug builds only.
        WebView.setWebContentsDebuggingEnabled((applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0)
        CookieManager.getInstance().setAcceptCookie(false)

        container = FrameLayout(this).apply { setBackgroundColor(page) }
        setContentView(container)
        ViewCompat.setOnApplyWindowInsetsListener(container) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            WindowInsetsCompat.CONSUMED
        }

        createWebView()

        onBackPressedDispatcher.addCallback(this, object : androidx.activity.OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val view = webView
                if (view != null && view.canGoBack()) view.goBack() else finish()
            }
        })

        if (savedInstanceState?.getBoolean(STATE_INTENT_HANDLED) != true) handleShareIntent(intent)
    }

    // The copied picture and the shared files are checked whenever the app starts, comes
    // back, goes to the background or is asked to free memory: anything past its time goes
    // then, and what is still live gets a timer for the rest of its time. (onStart also
    // covers the start-up.)
    override fun onStart() {
        super.onStart()
        sweepClips()
    }

    override fun onStop() {
        sweepClips()
        super.onStop()
    }

    override fun onResume() {
        super.onResume()
        // Back on the page, so the camera screen is closed; its result, if any, came first.
        cameraPending = false
        sweepCameraFiles()
    }

    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        sweepClips()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleShareIntent(intent)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putBoolean(STATE_INTENT_HANDLED, true)
        pendingOut?.let {
            outState.putString(STATE_OUT_PATH, it.file.absolutePath)
            outState.putString(STATE_OUT_MIME, it.mime)
        }
        // A photo the page has not pulled yet survives the activity being recreated.
        incoming?.takeIf { it.source == SOURCE_CAMERA }?.files?.firstOrNull()?.file
            ?.let { cameraFiles.idOf(it) }?.let { outState.putString(STATE_CAMERA_PHOTO, it) }
    }

    override fun onDestroy() {
        main.removeCallbacks(expireClip)
        // Leaving the app deletes a photo the page has not pulled yet; a recreation keeps it.
        incoming?.let { if (isFinishing) discard(it) else it.close() }
        // Leaving also deletes a file still waiting for its save screen (1.1.0).
        if (isFinishing) pendingOut?.let { out -> io.execute { outgoingFiles.delete(out.file) } }
        outTransfer?.abort()
        webView?.let { destroyWebView(it) }
        webView = null
        io.shutdown()
        super.onDestroy()
    }

    // ---------------------------------------------------------------- WebView

    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView() {
        val view = WebView(this)
        view.setBackgroundColor(ContextCompat.getColor(this, R.color.page_background))
        view.settings.apply {
            javaScriptEnabled = true
            // The first-run notice remembers its dismissal in localStorage.
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            setGeolocationEnabled(false)
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            cacheMode = WebSettings.LOAD_NO_CACHE
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            mediaPlaybackRequiresUserGesture = true
        }
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, false)
        view.webViewClient = Client()
        view.webChromeClient = Chrome()
        view.setDownloadListener { _, _, _, _, _ ->
            // Only reached when the bridge is missing, because the bridge catches every
            // download link first.
            if (!bridgeSupported) toast(R.string.webview_too_old)
        }

        bridgeSupported = false
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            bridgeSupported = true
            WebViewCompat.addWebMessageListener(
                view,
                BRIDGE_NAME,
                setOf(NavigationPolicy.ASSET_ORIGIN),
            ) { _, message, sourceOrigin, isMainFrame, proxy ->
                onBridgeMessage(message, sourceOrigin, isMainFrame, proxy)
            }
        }

        container.addView(view, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        webView = view
        replyProxy = null
        view.loadUrl(START_URL)
    }

    private fun destroyWebView(view: WebView) {
        container.removeView(view)
        view.stopLoading()
        view.destroy()
    }

    // onRenderProcessGone IS implemented below. The androidx.webkit lint check also fires
    // on any direct `WebViewClient()` constructor call, and in Kotlin the superclass call in
    // this class header is one, so the warning is a false positive here and only here.
    @SuppressLint("MissingOnRenderProcessGone")
    private inner class Client : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
            val url = request.url.toString()
            if (!NavigationPolicy.isAssetRequest(url)) return WebAssetHandler.forbidden()
            return assetLoader.shouldInterceptRequest(request.url) ?: WebAssetHandler.notFound()
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            // Leaving the app needs a tap. A navigation the page starts on its own (a script
            // setting location, a meta refresh) never opens the browser or another app, so
            // nothing can carry data off the device that way, even through a future page bug.
            val userTapped = request.isForMainFrame && request.hasGesture()
            return when (NavigationPolicy.decide(request.url.toString())) {
                NavigationPolicy.Decision.IN_APP -> false
                NavigationPolicy.Decision.EXTERNAL -> {
                    if (userTapped) openInBrowser(request.url)
                    true
                }
                NavigationPolicy.Decision.EXTERNAL_APP -> {
                    if (userTapped) openInOtherApp(request.url)
                    true
                }
                NavigationPolicy.Decision.BLOCK -> true
            }
        }

        override fun onRenderProcessGone(view: WebView?, detail: RenderProcessGoneDetail?): Boolean {
            // The page's renderer died, usually from memory pressure on a very large
            // picture. Without this the whole app would be killed with it.
            if (view != null && view === webView) {
                webView = null
                destroyWebView(view)
                incoming?.let { discard(it) }
                incoming = null
                outTransfer?.abort()
                outTransfer = null
                createWebView()
                toast(R.string.page_crashed)
            }
            return true
        }
    }

    private inner class Chrome : WebChromeClient() {
        override fun onShowFileChooser(
            webView: WebView,
            filePathCallback: ValueCallback<Array<Uri>>,
            fileChooserParams: FileChooserParams,
        ): Boolean {
            pendingChooser?.onReceiveValue(null)
            pendingChooser = filePathCallback
            val types = ImageTypes.MIME_TYPES.toTypedArray()
            return try {
                if (fileChooserParams.mode == FileChooserParams.MODE_OPEN_MULTIPLE) pickMany.launch(types) else pickOne.launch(types)
                true
            } catch (_: ActivityNotFoundException) {
                pendingChooser = null
                toast(R.string.no_app_for_files)
                false
            }
        }

        override fun onGeolocationPermissionsShowPrompt(
            origin: String?,
            callback: android.webkit.GeolocationPermissions.Callback,
        ) {
            callback.invoke(origin, false, false)
        }

        // The page never gets the camera, the microphone or the location, even with CAMERA
        // granted to the app (1.1.0): getUserMedia is always refused here, and "Take a photo"
        // in the app goes to CameraActivity through the bridge instead. A file input with
        // capture= still reaches only the system file picker above, never the camera.
        override fun onPermissionRequest(request: android.webkit.PermissionRequest) {
            request.deny()
        }
    }

    private fun deliverChosen(uris: Array<Uri>?) {
        val cb = pendingChooser ?: return
        pendingChooser = null
        cb.onReceiveValue(uris)
    }

    private fun openInBrowser(uri: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE))
        } catch (_: ActivityNotFoundException) {
            toast(R.string.no_app_for_link)
        }
    }

    /** mailto: goes to a mail app, nostr: to a Nostr client, as they would from a browser. */
    private fun openInOtherApp(uri: Uri) {
        val intent = if (uri.scheme.equals("mailto", ignoreCase = true)) {
            Intent(Intent.ACTION_SENDTO, uri)
        } else {
            Intent(Intent.ACTION_VIEW, uri)
        }
        try {
            startActivity(intent)
        } catch (_: ActivityNotFoundException) {
            toast(R.string.no_app_for_link)
        }
    }

    // ---------------------------------------------------------------- bridge

    private fun onBridgeMessage(message: WebMessageCompat, origin: Uri, isMainFrame: Boolean, proxy: JavaScriptReplyProxy) {
        // The listener is registered for the asset origin only; this is the second lock.
        if (!isMainFrame || !NavigationPolicy.isAssetOrigin(origin.toString())) return
        if (message.type != WebMessageCompat.TYPE_STRING) return
        val msg = try {
            JSONObject(message.data ?: return)
        } catch (_: Exception) {
            return
        }
        replyProxy = proxy
        when (msg.optString("t")) {
            "hello" -> {
                // A (re)loaded page. Anything half-transferred belonged to the old one.
                outTransfer?.abort()
                outTransfer = null
                incoming?.let { it.close(); announce(it) }
            }
            "out-begin" -> onOutBegin(msg)
            "out-chunk" -> onOutChunk(msg)
            "in-pull" -> onInPull(msg)
            "in-done" -> {
                val batch = incoming
                if (batch != null && batch.id == msg.optInt("batch")) {
                    // The page has the bytes: a photo taken in the app is deleted now.
                    discard(batch)
                    incoming = null
                }
            }
            "camera-open" -> openCamera()
        }
    }

    private fun send(obj: JSONObject) {
        val text = obj.toString()
        main.post {
            if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) replyProxy?.postMessage(text)
        }
    }

    // ---- page to app: the finished file

    private fun onOutBegin(msg: JSONObject) {
        outTransfer?.abort()
        outTransfer = null
        val id = msg.optInt("id")
        // Everything in this message comes from the page: OutgoingRequest checks the action,
        // type, size, chunk count and name, and there is no field for an address or a path.
        val request = OutgoingRequest.parse(
            msg.optString("action").takeIf { msg.has("action") },
            msg.optString("name").takeIf { msg.has("name") },
            msg.optString("mime"),
            msg.optLong("size", -1),
            msg.optInt("chunks", -1),
        )
        if (request == null) {
            failOut(id, null)
            return
        }
        if (request.action != OutgoingRequest.Action.COPY) {
            // A large result takes a few seconds to hand over, and the page shows nothing
            // meanwhile, so say that something is happening.
            Toast.makeText(this, getString(R.string.preparing, request.name), Toast.LENGTH_SHORT).show()
        }
        io.execute {
            val transfer = try {
                val file = outgoingFiles.newFile(request.name)
                val stream = FileOutputStream(file)
                OutTransfer(id, request.action, OutFile(file, request.mime), stream, ChunkAssembler(request.size, request.chunks, stream))
            } catch (_: Exception) {
                null
            }
            main.post {
                if (transfer == null) {
                    failOut(id, request.action)
                } else {
                    outTransfer = transfer
                    send(JSONObject().put("t", "out-pull").put("id", id).put("index", 0))
                }
            }
        }
    }

    /** Tells the page the file did not arrive. Only Save has no message of its own in the page. */
    private fun failOut(id: Int, action: OutgoingRequest.Action?) {
        send(JSONObject().put("t", "out-error").put("id", id))
        if (action == null || action == OutgoingRequest.Action.SAVE) toast(R.string.transfer_failed)
    }

    private fun onOutChunk(msg: JSONObject) {
        val transfer = outTransfer ?: return
        val id = msg.optInt("id")
        if (id != transfer.id) return
        val index = msg.optInt("index", -1)
        val data = msg.optString("data")
        io.execute {
            val result = try {
                transfer.assembler.append(index, Base64.decode(data))
                val next = transfer.assembler.next
                if (next == null) {
                    transfer.assembler.finish()
                    transfer.stream.close()
                    // The clipboard gets pixels only: the PNG is read through once more,
                    // refused if it carries anything but the chunks that draw the picture,
                    // and written again without drawing hints such as sRGB (PngCheck).
                    if (transfer.action == OutgoingRequest.Action.COPY) pixelsOnly(transfer.out.file)
                }
                next ?: DONE
            } catch (_: Exception) {
                transfer.abort()
                FAILED
            }
            main.post {
                if (outTransfer !== transfer) return@post
                when (result) {
                    FAILED -> {
                        outTransfer = null
                        failOut(id, transfer.action)
                    }
                    DONE -> {
                        outTransfer = null
                        finishOut(transfer)
                    }
                    else -> send(JSONObject().put("t", "out-pull").put("id", id).put("index", result))
                }
            }
        }
    }

    /** Rewrites [file] in place as a PNG of its pixel chunks only, or throws. IO thread only. */
    private fun pixelsOnly(file: File) {
        val clean = File(file.parentFile, "${file.name}.clean")
        val ok = file.inputStream().buffered().use { input ->
            FileOutputStream(clean).buffered().use { output -> PngCheck.copyPixelsOnly(input, output) }
        }
        if (!ok || !clean.renameTo(file)) {
            clean.delete()
            throw IllegalStateException("not a plain PNG")
        }
    }

    /** The whole file is here: do exactly what the page's button asked, and nothing else. */
    private fun finishOut(transfer: OutTransfer) {
        val ok = when (transfer.action) {
            OutgoingRequest.Action.SAVE -> {
                startSave(transfer.out)
                true
            }
            OutgoingRequest.Action.SHARE -> share(transfer.out)
            OutgoingRequest.Action.COPY -> copyToClipboard(transfer.out)
        }
        if (!ok) io.execute { outgoingFiles.delete(transfer.out.file) }
        val reply = JSONObject().put("t", if (ok) "out-done" else "out-error").put("id", transfer.id).put("ok", ok)
        // For a copy, the time it can still be pasted, so the page's line ends when the copy does.
        if (ok && transfer.action == OutgoingRequest.Action.COPY) {
            clipFiles.current()?.let { reply.put("expiresIn", clipFiles.remainingMs(it)) }
        }
        send(reply)
    }

    private fun startSave(out: OutFile) {
        if (isFinishing || isDestroyed) return
        pendingOut = out
        try {
            saveDocument.launch(out.mime to out.file.name)
        } catch (_: ActivityNotFoundException) {
            pendingOut = null
            io.execute { outgoingFiles.delete(out.file) }
            toast(R.string.save_failed)
        }
    }

    private fun onSaveTarget(target: Uri?) {
        val out = pendingOut ?: run {
            if (target != null) toast(R.string.file_gone)
            return
        }
        if (target == null) {
            // Cancelled (1.1.0): the copy made for the save screen goes now. Save in the page
            // makes a new one.
            pendingOut = null
            io.execute { outgoingFiles.delete(out.file) }
            return
        }
        val name = out.file.name
        io.execute {
            val ok = try {
                if (!out.file.isFile || !outgoingFiles.owns(out.file)) throw IllegalStateException("gone")
                openForWrite(target).use { sink -> out.file.inputStream().use { it.copyTo(sink) } }
                true
            } catch (_: Exception) {
                false
            }
            // Only this file's own folder goes, saved or not (a failed save is tried again
            // from the page, which makes a new copy). Another result may still be arriving or
            // waiting in its dialog, and a file shared earlier may not have been read yet by
            // the app it went to; that one stays for its 10 minutes (OutgoingFiles).
            outgoingFiles.delete(out.file)
            main.post {
                pendingOut = null
                if (ok) Toast.makeText(this, getString(R.string.saved, name), Toast.LENGTH_SHORT).show()
                else toast(R.string.save_failed)
            }
        }
    }

    private fun openForWrite(uri: Uri): OutputStream =
        try {
            contentResolver.openOutputStream(uri, "wt")
        } catch (_: Exception) {
            null
        } ?: contentResolver.openOutputStream(uri, "w") ?: throw IllegalStateException("no stream")

    /**
     * Android's share sheet with the file, straight away; the page shows the warning. The
     * file first moves to a folder named for now (OutgoingFiles.markShared): the app it goes
     * to can read it for 10 minutes, then the timer, the alarm or the provider deletes it.
     */
    private fun share(out: OutFile): Boolean {
        if (isFinishing || isDestroyed) return false
        var shared: File? = null
        return try {
            val file = outgoingFiles.markShared(out.file).also { shared = it }
            val uri = FileProvider.getUriForFile(this, authority, file)
            val send = Intent(Intent.ACTION_SEND)
                .setType(out.mime)
                .putExtra(Intent.EXTRA_STREAM, uri)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            send.clipData = ClipData.newRawUri(file.name, uri)
            val chooser = Intent.createChooser(send, getString(R.string.share_chooser))
            // Sharing the clean file back into this app would only start over, so the app
            // leaves itself out of the list.
            chooser.putExtra(Intent.EXTRA_EXCLUDE_COMPONENTS, arrayOf(android.content.ComponentName(this, MainActivity::class.java)))
            startActivity(chooser)
            scheduleExpiry()
            true
        } catch (_: Exception) {
            shared?.let { outgoingFiles.delete(it) }
            false
        }
    }

    /**
     * Android's clipboard gets the page's fresh PNG (checked by PngCheck) through the
     * FileProvider, under the label "image". The PNG moves to cache/clipboard/ and can be
     * pasted for 2 minutes (ClipboardFiles.LIFETIME_MS): a newer Copy deletes the older one at
     * once and starts its own 2 minutes; after them the timer deletes the file, withdraws the
     * read grants and clears the clipboard if it still holds this picture, and
     * OutgoingProvider refuses the address in any case.
     */
    private fun copyToClipboard(out: OutFile): Boolean {
        if (out.mime != OutgoingRequest.COPY_MIME) return false
        var moved: File? = null
        return try {
            val clipboard = getSystemService(ClipboardManager::class.java) ?: return false
            clipFiles.current()?.let { revokeClip(it) }
            val file = clipFiles.adopt(out.file)
            moved = file
            pageClip = file
            val uri = FileProvider.getUriForFile(this, authority, file)
            clipboard.setPrimaryClip(ClipData(ClipDescription(CLIP_LABEL, arrayOf(out.mime)), ClipData.Item(uri)))
            scheduleExpiry()
            true
        } catch (_: Exception) {
            moved?.parentFile?.deleteRecursively()
            false
        }
    }

    /**
     * Deletes every copy past its 2 minutes and every shared file past its 10, withdraws
     * their read grants, clears the clipboard if it still holds that picture (only possible
     * while the app has the focus), and sets the timer and the alarm for whatever is still
     * live, if anything.
     */
    private fun sweepClips() {
        main.removeCallbacks(expireClip)
        val gone = ClipExpiry.sweep(this)
        if (gone.isNotEmpty()) clearClipboardIfOurs(gone)
        // Also when the background alarm ended it while the app was away.
        if (clipFiles.hasEnded(pageClip)) {
            pageClip = null
            send(JSONObject().put("t", "clip-expired"))
        }
        ClipExpiry.nextDueMs(this)?.let { main.postDelayed(expireClip, it) }
    }

    /** The timer and the background alarm, for whichever copy or shared file ends first. */
    private fun scheduleExpiry() {
        main.removeCallbacks(expireClip)
        ClipExpiry.schedule(this)?.let { main.postDelayed(expireClip, it) }
    }

    private fun revokeClip(file: File) = ClipExpiry.revoke(this, file)

    private fun clearClipboardIfOurs(files: List<File>) {
        if (android.os.Build.VERSION.SDK_INT < 28) return
        try {
            val clipboard = getSystemService(ClipboardManager::class.java) ?: return
            val uris = files.map { FileProvider.getUriForFile(this, authority, it) }.toSet()
            // Android shows the clipboard only to the app in focus; in the background this
            // reads nothing and the clipboard is left alone (the provider still refuses).
            val clip = clipboard.primaryClip ?: return
            if (clip.itemCount == 1 && clip.getItemAt(0).uri in uris) clipboard.clearPrimaryClip()
        } catch (_: Exception) {
            // Leave the clipboard alone.
        }
    }

    private val authority: String get() = ClipExpiry.authority(this)

    private fun restorePendingOut(state: Bundle) {
        val path = state.getString(STATE_OUT_PATH) ?: return
        val mime = state.getString(STATE_OUT_MIME) ?: return
        val file = File(path)
        if (file.isFile && outgoingFiles.owns(file) && ImageTypes.isSupported(mime)) pendingOut = OutFile(file, mime)
    }

    // ---- app to page: pictures shared in

    private fun handleShareIntent(intent: Intent?) {
        val uris = sharedUris(intent ?: return)
        if (uris.isEmpty()) return
        // Consume it, so a configuration change or a re-delivered intent never re-imports.
        setIntent(Intent(Intent.ACTION_MAIN))
        val own = setOf("$packageName.outgoing")
        val resolver = contentResolver
        val batchId = nextBatchId++
        io.execute {
            val files = mutableListOf<IncomingFile>()
            var skipped = 0
            for ((i, uri) in uris.take(IncomingPolicy.MAX_FILES).withIndex()) {
                if (!IncomingPolicy.accept(uri.scheme, uri.authority, own)) { skipped++; continue }
                var name: String? = null
                var size = -1L
                try {
                    resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                        if (c.moveToFirst()) {
                            val n = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                            val s = c.getColumnIndex(OpenableColumns.SIZE)
                            if (n >= 0 && !c.isNull(n)) name = c.getString(n)
                            if (s >= 0 && !c.isNull(s)) size = c.getLong(s)
                        }
                    }
                } catch (_: Exception) {
                    // Some providers refuse the query; the name and size are optional.
                }
                val mime = try { resolver.getType(uri) } catch (_: Exception) { null }
                val type = ImageTypes.resolveIncoming(mime, name)
                if (type == null || size > IncomingPolicy.MAX_BYTES) { skipped++; continue }
                files += IncomingFile(uri, null, FileNames.incomingDisplayName(name, type, i), type, size)
            }
            skipped += (uris.size - IncomingPolicy.MAX_FILES).coerceAtLeast(0)
            main.post {
                if (skipped > 0) {
                    Toast.makeText(this, resources.getQuantityString(R.plurals.skipped_files, skipped, skipped), Toast.LENGTH_LONG).show()
                }
                if (files.isEmpty()) return@post
                incoming?.let { discard(it) }
                val batch = IncomingBatch(batchId, files, SOURCE_SHARE)
                incoming = batch
                announce(batch)
            }
        }
    }

    private fun sharedUris(intent: Intent): List<Uri> {
        val fromExtras: List<Uri> = when (intent.action) {
            Intent.ACTION_SEND ->
                listOfNotNull(IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java))
            Intent.ACTION_SEND_MULTIPLE ->
                IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java).orEmpty()
            else -> return emptyList()
        }
        if (fromExtras.isNotEmpty()) return fromExtras
        val clip = intent.clipData ?: return emptyList()
        return (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri }
    }

    /** Tells the page a batch is waiting. The page pulls it once it is ready. */
    private fun announce(batch: IncomingBatch) {
        if (replyProxy == null) return // the page's "hello" will trigger it
        val files = JSONArray()
        batch.files.forEach { files.put(JSONObject().put("name", it.name).put("mime", it.mime).put("size", it.size)) }
        val msg = JSONObject().put("t", "incoming").put("batch", batch.id).put("files", files)
        if (batch.source == SOURCE_CAMERA) msg.put("source", SOURCE_CAMERA)
        send(msg)
    }

    /**
     * Ends a batch for good: closes its stream and deletes a photo taken in the app (its
     * file and folder in cache/camera/). Shared pictures belong to the app that shared them
     * and are only closed. close() alone is for a page reload, which pulls the batch again.
     */
    private fun discard(batch: IncomingBatch) {
        batch.close()
        val photos = batch.files.mapNotNull { it.file }
        if (photos.isNotEmpty()) io.execute { photos.forEach { cameraFiles.delete(it) } }
    }

    // ---- the camera (1.1.0)

    /** "camera-open" from the page's Take a photo. The page cannot take a photo itself. */
    private fun openCamera() {
        if (cameraPending) return
        if (!packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)) {
            toast(R.string.camera_none)
            sendCameraResult(false)
            return
        }
        cameraPending = true
        try {
            takePhoto.launch(Unit)
        } catch (_: ActivityNotFoundException) {
            cameraPending = false
            sendCameraResult(false)
        }
    }

    private fun sendCameraResult(ok: Boolean) = send(JSONObject().put("t", "camera-result").put("ok", ok))

    /**
     * The camera screen closed, with the UUID of a photo or without. The file is checked
     * once more (pixels only, read-only) and then announced to the page as a camera batch,
     * which replaces anything shared in that the page has not pulled yet.
     */
    private fun onPhotoTaken(id: String?) {
        cameraPending = false
        if (id == null) {
            sendCameraResult(false)
            return
        }
        checkingPhoto = id
        io.execute {
            val file = cameraFiles.resolve(id)
            val ok = file != null && try {
                file.inputStream().use { JpegCheck.isPixelsOnly(it) }
            } catch (_: Exception) {
                false
            }
            if (!ok) file?.let { cameraFiles.delete(it) }
            main.post {
                if (checkingPhoto == id) checkingPhoto = null
                if (isFinishing || isDestroyed) {
                    // Left the app meanwhile: nothing stays behind (the IO thread is gone).
                    if (file != null) cameraFiles.delete(file)
                    return@post
                }
                if (!ok) {
                    toast(R.string.camera_prepare_failed)
                    sendCameraResult(false)
                    return@post
                }
                sendCameraResult(true)
                incoming?.let { discard(it) }
                val batch = cameraBatch(file)
                incoming = batch
                announce(batch)
            }
        }
    }

    private fun cameraBatch(file: File) =
        IncomingBatch(nextBatchId++, listOf(IncomingFile(null, file, CAMERA_NAME, CAMERA_MIME, file.length())), SOURCE_CAMERA)

    /**
     * Removes every photo folder in cache/camera/ but the photo waiting for the page and one
     * still being checked (1.1.0). A fresh start clears the whole folder; this also covers a
     * return after Android stopped the process, which restores the app instead of starting it
     * afresh, so a photo or half-written file a killed process left behind does not stay. It
     * runs in onResume, after the camera screen's result has arrived (onPhotoTaken), so the
     * photo just taken is always kept; the IO thread checks it before this sweep runs.
     */
    private fun sweepCameraFiles() {
        val waiting = incoming?.files?.firstNotNullOfOrNull { it.file }?.parentFile?.name
        val keep = setOfNotNull(checkingPhoto, waiting)
        io.execute { cameraFiles.clearExcept(keep) }
    }

    /** After the activity was recreated: a photo the page had not pulled yet is offered again. */
    private fun restoreCameraPhoto(state: Bundle) {
        val file = cameraFiles.resolve(state.getString(STATE_CAMERA_PHOTO) ?: return) ?: return
        incoming = cameraBatch(file)
    }

    private fun onInPull(msg: JSONObject) {
        val batch = incoming ?: return
        val batchId = msg.optInt("batch")
        if (batchId != batch.id) return
        val fileIndex = msg.optInt("file", -1)
        val index = msg.optInt("index", -1)
        val resolver = contentResolver
        io.execute {
            val reply = try {
                val chunk = batch.read(resolver, fileIndex, index)
                JSONObject().put("t", "in-chunk").put("batch", batchId).put("file", fileIndex).put("index", index)
                    .put("data", Base64.encode(chunk.bytes)).put("last", chunk.last)
            } catch (_: Exception) {
                batch.closeStream()
                // A photo taken in the app that cannot be read is of no use to anyone.
                batch.files.getOrNull(fileIndex)?.file?.let { cameraFiles.delete(it) }
                main.post { toast(R.string.read_failed) }
                JSONObject().put("t", "in-error").put("batch", batchId).put("file", fileIndex)
            }
            main.post { if (incoming === batch) send(reply) }
        }
    }

    private fun toast(res: Int) {
        Toast.makeText(this, res, Toast.LENGTH_LONG).show()
    }

    // ---------------------------------------------------------------- types

    private class OutFile(val file: File, val mime: String)

    private class OutTransfer(
        val id: Int,
        val action: OutgoingRequest.Action,
        val out: OutFile,
        val stream: OutputStream,
        val assembler: ChunkAssembler,
    ) {
        fun abort() {
            try { stream.close() } catch (_: Exception) {}
            out.file.delete()
            out.file.parentFile?.delete()
        }
    }

    /**
     * One picture for the page: from a share ([uri], a content: address checked by
     * IncomingPolicy) or a photo taken in the app ([file], in cache/camera/, chosen by the
     * app itself and never through IncomingPolicy, which keeps refusing file: addresses).
     */
    private class IncomingFile(val uri: Uri?, val file: File?, val name: String, val mime: String, val size: Long)

    private class Chunk(val bytes: ByteArray, val last: Boolean)

    /** A share's pictures or a photo taken in the app, read one chunk at a time, in order, on the IO thread. */
    private class IncomingBatch(val id: Int, val files: List<IncomingFile>, val source: String) {
        private var openFile = -1
        private var stream: InputStream? = null
        private var nextIndex = 0
        private var total = 0L

        @Synchronized
        fun read(resolver: android.content.ContentResolver, file: Int, index: Int): Chunk {
            require(file in files.indices) { "no file $file" }
            if (file != openFile) {
                closeStream()
                require(index == 0) { "file $file must start at chunk 0" }
                val f = files[file]
                stream = f.file?.inputStream()
                    ?: f.uri?.let { resolver.openInputStream(it) }
                    ?: throw IllegalStateException("no stream")
                openFile = file
                nextIndex = 0
                total = 0
            }
            require(index == nextIndex) { "chunk $index requested, expected $nextIndex" }
            val input = stream ?: throw IllegalStateException("closed")
            val buf = ByteArray(ChunkAssembler.CHUNK_BYTES)
            var n = 0
            while (n < buf.size) {
                val r = input.read(buf, n, buf.size - n)
                if (r < 0) break
                n += r
            }
            if (index == 0 && n == 0) throw IllegalStateException("empty file")
            total += n
            if (total > IncomingPolicy.MAX_BYTES) throw IllegalStateException("too large")
            nextIndex += 1
            val last = n < buf.size
            if (last) closeStream()
            return Chunk(if (n == buf.size) buf else buf.copyOf(n), last)
        }

        @Synchronized
        fun closeStream() {
            try { stream?.close() } catch (_: Exception) {}
            stream = null
            openFile = -1
        }

        fun close() = closeStream()
    }

    /** Opens the camera screen; the result is the photo's UUID, or null. */
    private class TakePhoto : ActivityResultContract<Unit, String?>() {
        override fun createIntent(context: Context, input: Unit): Intent = Intent(context, CameraActivity::class.java)

        override fun parseResult(resultCode: Int, intent: Intent?): String? =
            if (resultCode == android.app.Activity.RESULT_OK) intent?.getStringExtra(CameraActivity.EXTRA_PHOTO) else null
    }

    /** ACTION_CREATE_DOCUMENT with the MIME type chosen per file rather than per launcher. */
    private class CreateTypedDocument : ActivityResultContract<Pair<String, String>, Uri?>() {
        override fun createIntent(context: Context, input: Pair<String, String>): Intent =
            Intent(Intent.ACTION_CREATE_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType(input.first)
                .putExtra(Intent.EXTRA_TITLE, input.second)

        override fun parseResult(resultCode: Int, intent: Intent?): Uri? =
            if (resultCode == android.app.Activity.RESULT_OK) intent?.data else null
    }

    companion object {
        private const val START_URL = "https://${NavigationPolicy.ASSET_HOST}/index.html"
        private const val BRIDGE_NAME = "MSBridge"
        private const val CLIP_LABEL = "image"

        private const val DONE = -1
        private const val FAILED = -2

        private const val STATE_INTENT_HANDLED = "intent_handled"
        private const val STATE_OUT_PATH = "out_path"
        private const val STATE_OUT_MIME = "out_mime"
        private const val STATE_CAMERA_PHOTO = "camera_photo"

        private const val SOURCE_SHARE = "share"
        private const val SOURCE_CAMERA = "camera"
        private const val CAMERA_NAME = "photo.jpg"
        private const val CAMERA_MIME = "image/jpeg"
    }
}
