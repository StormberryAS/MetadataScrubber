package no.stormberry.metadatascrubber

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.ColorSpace
import android.graphics.ImageFormat
import android.graphics.Matrix
import android.media.MediaActionSound
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.util.Size
import android.view.MotionEvent
import android.view.OrientationEventListener
import android.view.ScaleGestureDetector
import android.view.View
import android.widget.Button
import android.widget.ImageButton
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.CameraState
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.AspectRatioStrategy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.core.graphics.scale
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.LiveData
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.FileOutputStream
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * The in-app camera (1.1.0; Marcos, 2026-10-10): a quick photo of a market stall to send to
 * family, or of an event to post, without the photo ever carrying a location or device
 * details. Not a full camera: a shutter, a front or back switch, a flash toggle where the
 * camera has one, and pinch to zoom. Nothing else.
 *
 * How the photo is made, and why it holds no metadata:
 *  1. CameraX hands the picture over IN MEMORY (OnImageCapturedCallback), never through
 *     OutputFileOptions: CameraX's own file writer adds EXIF with the phone's make and model,
 *     and its MediaStore option would put the photo in the gallery. No location and no
 *     capture metadata are ever set on the capture.
 *  2. The camera's JPEG, whose header names the phone, exists only in that buffer. It is
 *     decoded to pixels (BitmapFactory ignores EXIF; a Display P3 photo is converted to
 *     sRGB first, so colours are not mislabelled when the profile goes), turned upright by
 *     the angle the camera reports, and encoded again with Android's encoder at quality 90.
 *     The front camera's photo is not mirrored: it shows the scene as it is, so text in it
 *     reads correctly, while the preview is mirrored as in every camera app.
 *  3. JpegCheck.copyPixelsOnly then keeps only what draws the picture, so the JFIF header
 *     and any colour profile the encoder added go too, and anything unexpected fails the
 *     photo rather than leaking.
 *  4. The result is written once, to cache/camera/<uuid>/photo.jpg (CameraFiles), private
 *     to the app, never shared through the FileProvider and never added to the gallery.
 *     MainActivity gets only the UUID, checks the file again and hands it to the page, then
 *     deletes it as soon as the page has the bytes.
 *
 * The CAMERA permission is asked for here, when Take a photo is tapped without it, after the
 * app's own explanation (CameraPermission). Not exported: only MainActivity starts it, and
 * only the shutter's own click handler ever takes a photo; no page message can.
 */
class CameraActivity : ComponentActivity() {

    private lateinit var previewView: PreviewView
    private lateinit var topBar: View
    private lateinit var bottomBar: View
    private lateinit var shutter: ImageButton
    private lateinit var switchButton: ImageButton
    private lateinit var flashButton: ImageButton
    private lateinit var status: TextView
    private lateinit var flashOverlay: View
    private lateinit var panel: View
    private lateinit var panelContent: View
    private lateinit var panelTitle: TextView
    private lateinit var panelBody: TextView
    private lateinit var panelPrimary: Button
    private lateinit var panelSecondary: Button

    private lateinit var cameraFiles: CameraFiles
    private val worker: ExecutorService = Executors.newSingleThreadExecutor()
    private val sound = MediaActionSound()

    private var provider: ProcessCameraProvider? = null
    private var camera: Camera? = null
    private var observedState: LiveData<CameraState>? = null
    private var imageCapture: ImageCapture? = null
    private var hasBack = false
    private var hasFront = false
    private var useFront = false
    private var flashOn = false
    private var startFailed = false

    // The last way the phone was seen held, as a Surface rotation; null until the listener
    // has reported one. A rebound ImageCapture starts from it (CameraRotation.captureRotation).
    private var sensorRotation: Int? = null

    // A photo is being taken or prepared; the shutter and the switch wait for the result.
    private var busy = false

    // Set when the screen closes, from any thread's point of view: the worker then writes
    // nothing, or deletes what it wrote.
    @Volatile private var cancelled = false

    private enum class Panel { NONE, RATIONALE, DENIED }
    private var panelState = Panel.NONE

    private val requestCamera = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        go(CameraPermission.afterRequest(granted, shouldShowRequestPermissionRationale(Manifest.permission.CAMERA)))
    }

    // The way the phone is held, for the photo; the screen itself may not turn (auto-rotate
    // off), so its rotation cannot say which way is up.
    private val orientation by lazy {
        object : OrientationEventListener(this) {
            override fun onOrientationChanged(degrees: Int) {
                val rotation = CameraRotation.surfaceRotationFor(degrees) ?: return
                // Kept, because the first reading often comes before the camera is bound,
                // and every switch builds a new ImageCapture.
                sensorRotation = rotation
                imageCapture?.targetRotation = rotation
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        val black = ContextCompat.getColor(this, R.color.camera_background)
        // The status bar is see-through, so the explanation panel's own background runs up
        // behind it without a black seam; over the camera the window behind is black anyway.
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(black),
        )
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_camera)
        cameraFiles = CameraFiles(cacheDir)

        previewView = findViewById(R.id.camera_preview)
        topBar = findViewById(R.id.camera_top_bar)
        bottomBar = findViewById(R.id.camera_bottom_bar)
        shutter = findViewById(R.id.camera_shutter)
        switchButton = findViewById(R.id.camera_switch)
        flashButton = findViewById(R.id.camera_flash)
        status = findViewById(R.id.camera_status)
        flashOverlay = findViewById(R.id.camera_flash_overlay)
        panel = findViewById(R.id.camera_panel)
        panelContent = findViewById(R.id.camera_panel_content)
        panelTitle = findViewById(R.id.camera_panel_title)
        panelBody = findViewById(R.id.camera_panel_body)
        panelPrimary = findViewById(R.id.camera_panel_primary)
        panelSecondary = findViewById(R.id.camera_panel_secondary)
        ViewCompat.setAccessibilityHeading(panelTitle, true)
        previewView.scaleType = PreviewView.ScaleType.FIT_CENTER
        applyInsets()

        savedInstanceState?.let {
            useFront = it.getBoolean(STATE_FRONT)
            flashOn = it.getBoolean(STATE_FLASH)
        }

        sound.load(MediaActionSound.SHUTTER_CLICK)
        findViewById<ImageButton>(R.id.camera_close).setOnClickListener { close() }
        shutter.setOnClickListener { takePhoto() }
        switchButton.setOnClickListener {
            if (busy) return@setOnClickListener
            useFront = !useFront
            bindCamera()
        }
        flashButton.setOnClickListener {
            flashOn = !flashOn
            applyFlash()
        }
        setUpZoom()

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = close()
        })

        // Back from process death on the "access is off" screen: stay on it.
        if (savedInstanceState?.getString(STATE_PANEL) == Panel.DENIED.name && !hasPermission()) {
            showPanel(Panel.DENIED)
        } else {
            go(CameraPermission.afterTap(hasPermission()))
        }
    }

    override fun onStart() {
        super.onStart()
        if (orientation.canDetectOrientation()) orientation.enable()
    }

    override fun onResume() {
        super.onResume()
        // Back from the app's settings: the camera opens if it was allowed there.
        if (panelState == Panel.DENIED) {
            val next = CameraPermission.afterSettings(hasPermission())
            if (next == CameraPermission.Next.OPEN) go(next)
        }
    }

    override fun onStop() {
        orientation.disable()
        super.onStop()
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        // The preview needs nothing here: PreviewView follows the screen itself, including a
        // turn straight from one landscape to the other, which reports no configuration change
        // (see bindCamera). The photo follows the phone, or the screen on a phone that cannot
        // tell how it is held.
        imageCapture?.targetRotation = CameraRotation.captureRotation(sensorRotation, displayRotation())
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putString(STATE_PANEL, panelState.name)
        outState.putBoolean(STATE_FRONT, useFront)
        outState.putBoolean(STATE_FLASH, flashOn)
    }

    override fun onDestroy() {
        // A photo still being prepared finishes on the worker and deletes itself, because
        // the screen is finishing (see onCaptureSuccess).
        worker.shutdown()
        sound.release()
        super.onDestroy()
    }

    // ---------------------------------------------------------------- permission

    private fun hasPermission(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED

    private fun go(next: CameraPermission.Next) {
        when (next) {
            CameraPermission.Next.OPEN -> {
                showPanel(Panel.NONE)
                startCamera()
            }
            CameraPermission.Next.RATIONALE -> showPanel(Panel.RATIONALE)
            CameraPermission.Next.DENIED -> showPanel(Panel.DENIED)
            CameraPermission.Next.CLOSE -> close()
        }
    }

    private fun showPanel(state: Panel) {
        panelState = state
        // While a panel is up, screen readers read only the panel.
        val behind = if (state == Panel.NONE) View.IMPORTANT_FOR_ACCESSIBILITY_AUTO else View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        topBar.importantForAccessibility = behind
        bottomBar.importantForAccessibility = behind
        when (state) {
            Panel.NONE -> {
                panel.visibility = View.GONE
                setTitle(R.string.camera_title)
                return
            }
            Panel.RATIONALE -> {
                panelTitle.setText(R.string.camera_rationale_title)
                panelBody.setText(R.string.camera_rationale_body)
                panelPrimary.setText(R.string.camera_rationale_continue)
                panelSecondary.setText(R.string.camera_rationale_not_now)
                panelPrimary.setOnClickListener { requestCamera.launch(Manifest.permission.CAMERA) }
            }
            Panel.DENIED -> {
                panelTitle.setText(R.string.camera_denied_title)
                panelBody.setText(R.string.camera_denied_body)
                panelPrimary.setText(R.string.camera_denied_settings)
                panelSecondary.setText(R.string.camera_denied_close)
                panelPrimary.setOnClickListener { openAppSettings() }
            }
        }
        panelSecondary.setOnClickListener { close() }
        // Screen readers announce the panel by its title when it appears, and the window
        // carries the same title, rather than the app's name.
        title = panelTitle.text
        ViewCompat.setAccessibilityPaneTitle(panel, panelTitle.text)
        panel.visibility = View.VISIBLE
    }

    private fun openAppSettings() {
        try {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null)))
        } catch (_: ActivityNotFoundException) {
            // No settings screen to open; the explanation stays.
        }
    }

    // ---------------------------------------------------------------- camera

    private fun startCamera() {
        if (provider != null) {
            bindCamera()
            return
        }
        val future = ProcessCameraProvider.getInstance(this)
        future.addListener({
            if (isFinishing || isDestroyed) return@addListener
            val p = try {
                future.get()
            } catch (_: Exception) {
                showStartFailed()
                return@addListener
            }
            provider = p
            hasBack = has(p, CameraSelector.DEFAULT_BACK_CAMERA)
            hasFront = has(p, CameraSelector.DEFAULT_FRONT_CAMERA)
            if (!hasBack && !hasFront) {
                Toast.makeText(this, R.string.camera_none, Toast.LENGTH_LONG).show()
                close()
                return@addListener
            }
            // Start with the back camera; a device with only a front one gets that.
            if (!hasBack) useFront = true
            if (!hasFront) useFront = false
            switchButton.visibility = if (hasBack && hasFront) View.VISIBLE else View.GONE
            bindCamera()
        }, ContextCompat.getMainExecutor(this))
    }

    private fun has(p: ProcessCameraProvider, selector: CameraSelector): Boolean =
        try {
            p.hasCamera(selector)
        } catch (_: Exception) {
            false
        }

    private fun bindCamera() {
        val p = provider ?: return
        val selector = if (useFront) CameraSelector.DEFAULT_FRONT_CAMERA else CameraSelector.DEFAULT_BACK_CAMERA
        val fourThree = AspectRatioStrategy.RATIO_4_3_FALLBACK_AUTO_STRATEGY
        // No target rotation on the preview, on purpose: with none set, PreviewView follows
        // the screen's rotation itself, through its own display listener. With one set, it
        // trusts that value whenever it draws through a TextureView (Android 7.0, LEGACY
        // cameras and some quirky devices), and a turn straight from one landscape to the
        // other, which reports no configuration change, left the preview upside down there.
        val newPreview = Preview.Builder()
            .setResolutionSelector(ResolutionSelector.Builder().setAspectRatioStrategy(fourThree).build())
            .build()
        newPreview.surfaceProvider = previewView.surfaceProvider
        // About 12 megapixels, 4:3, at most 4032 x 3024. Flash off unless the user turns it
        // on. Only the in-memory takePicture is ever used (see takePhoto).
        val capture = ImageCapture.Builder()
            .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
            .setResolutionSelector(
                ResolutionSelector.Builder()
                    .setAspectRatioStrategy(fourThree)
                    .setResolutionStrategy(ResolutionStrategy(MAX_SIZE, ResolutionStrategy.FALLBACK_RULE_CLOSEST_LOWER_THEN_HIGHER))
                    .build(),
            )
            .setFlashMode(ImageCapture.FLASH_MODE_OFF)
            .setTargetRotation(CameraRotation.captureRotation(sensorRotation, displayRotation()))
            .build()
        observedState?.removeObservers(this)
        observedState = null
        try {
            p.unbindAll()
            val cam = p.bindToLifecycle(this, selector, newPreview, capture)
            camera = cam
            imageCapture = capture
            observedState = cam.cameraInfo.cameraState.also { live -> live.observe(this) { onCameraState(it) } }
        } catch (_: Exception) {
            camera = null
            imageCapture = null
            showStartFailed()
            return
        }
        applyFlash()
        switchButton.contentDescription = getString(if (useFront) R.string.camera_switch_back else R.string.camera_switch_front)
    }

    private fun onCameraState(state: CameraState) {
        val error = state.error
        if (error != null) {
            // Turned off by a device policy or Android's own camera switch: another app is
            // not the reason, so the usual text would send the user looking for one.
            showStartFailed(if (error.code == CameraState.ERROR_CAMERA_DISABLED) R.string.camera_disabled else R.string.camera_start_failed)
        } else if (state.type == CameraState.Type.OPEN && startFailed) {
            startFailed = false
            if (!busy) showStatus(null)
        }
    }

    private fun showStartFailed(message: Int = R.string.camera_start_failed) {
        startFailed = true
        if (!busy) showStatus(message)
    }

    private fun displayRotation(): Int = ContextCompat.getDisplayOrDefault(this).rotation

    /** The flash toggle shows only for a camera that has a flash; Off to start with. */
    private fun applyFlash() {
        val hasFlash = camera?.cameraInfo?.hasFlashUnit() == true
        flashButton.visibility = if (hasFlash) View.VISIBLE else View.GONE
        val on = hasFlash && flashOn
        imageCapture?.flashMode = if (on) ImageCapture.FLASH_MODE_ON else ImageCapture.FLASH_MODE_OFF
        flashButton.setImageResource(if (on) R.drawable.ic_camera_flash_on else R.drawable.ic_camera_flash_off)
        flashButton.contentDescription = getString(if (on) R.string.camera_flash_turn_off else R.string.camera_flash_turn_on)
    }

    /** Pinch to zoom, within what the camera allows. No buttons, no readout, no tap to focus. */
    private fun setUpZoom() {
        val detector = ScaleGestureDetector(this, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
            override fun onScale(detector: ScaleGestureDetector): Boolean {
                val cam = camera ?: return false
                val zoom = cam.cameraInfo.zoomState.value ?: return false
                val ratio = (zoom.zoomRatio * detector.scaleFactor).coerceIn(zoom.minZoomRatio, zoom.maxZoomRatio)
                cam.cameraControl.setZoomRatio(ratio)
                return true
            }
        })
        previewView.setOnTouchListener { view, event ->
            detector.onTouchEvent(event)
            if (event.actionMasked == MotionEvent.ACTION_UP) view.performClick()
            true
        }
    }

    // ---------------------------------------------------------------- the photo

    private fun takePhoto() {
        val capture = imageCapture ?: return
        if (busy) return
        busy = true
        setControlsEnabled(false)
        showStatus(R.string.camera_preparing)
        sound.play(MediaActionSound.SHUTTER_CLICK)
        flashScreen()
        // IN MEMORY ONLY. Never takePicture(OutputFileOptions, ...): CameraX's file writer
        // adds EXIF with the phone's make and model, and its MediaStore option would put the
        // photo in the gallery. Never setLocation or any capture metadata either.
        capture.takePicture(worker, object : ImageCapture.OnImageCapturedCallback() {
            override fun onCaptureSuccess(image: ImageProxy) {
                // On the worker thread.
                val id = try {
                    prepare(image)
                } catch (_: Exception) {
                    null
                } catch (_: OutOfMemoryError) {
                    null
                }
                runOnUiThread { delivered(id) }
            }

            override fun onError(exception: ImageCaptureException) {
                runOnUiThread { if (!isFinishing && !isDestroyed) failed(R.string.camera_capture_failed) }
            }
        })
    }

    /** The prepared photo's id, or null when it failed. On the main thread. */
    private fun delivered(id: String?) {
        // Closed while the photo was prepared, or alone in its task (Android dropped the page
        // behind it, so nobody would receive the photo): nothing stays behind.
        if (isFinishing || isDestroyed || cancelled || isTaskRoot) {
            id?.let { cameraFiles.resolve(it)?.let(cameraFiles::delete) }
            if (isTaskRoot && !isFinishing) finish()
            return
        }
        if (id == null) {
            failed(R.string.camera_prepare_failed)
            return
        }
        // Only the UUID travels, never a path.
        setResult(RESULT_OK, Intent().putExtra(EXTRA_PHOTO, id))
        finish()
    }

    private fun failed(message: Int) {
        busy = false
        setControlsEnabled(true)
        showStatus(message)
    }

    /**
     * Makes the photo from the camera's picture and writes it, the only write to storage.
     * Returns its id, or null. On the worker thread.
     */
    private fun prepare(image: ImageProxy): String? {
        val rotation = image.imageInfo.rotationDegrees
        var fromProxy: Bitmap? = null
        // The camera's JPEG, with its own header naming the phone, exists only in this buffer.
        val jpeg: ByteArray? = image.use {
            if (it.format == ImageFormat.JPEG) {
                val buffer = it.planes[0].buffer
                ByteArray(buffer.remaining()).also { bytes -> buffer.get(bytes) }
            } else {
                fromProxy = it.toBitmap()
                null
            }
        }
        // Too little memory for the whole picture: once more at half the size, then give up.
        val upright = uprightBitmap(jpeg, fromProxy, rotation, 1)
            ?: uprightBitmap(jpeg, fromProxy, rotation, 2)
            ?: return null
        if (cancelled) {
            upright.recycle()
            return null
        }
        val encoded = ByteArrayOutputStream(upright.byteCount / 10)
        val ok = upright.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, encoded)
        upright.recycle()
        if (!ok) return null
        val clean = ByteArrayOutputStream(encoded.size())
        if (!JpegCheck.copyPixelsOnly(ByteArrayInputStream(encoded.toByteArray()), clean)) return null
        if (cancelled) return null
        val part = cameraFiles.newPhoto()
        try {
            FileOutputStream(part).use { clean.writeTo(it) }
        } catch (_: Exception) {
            cameraFiles.delete(part)
            return null
        }
        return cameraFiles.commit(part)
    }

    /**
     * The picture as sRGB pixels, turned upright by [rotation] degrees and not mirrored, at
     * 1/[sample] of its size; null when there is not enough memory.
     */
    private fun uprightBitmap(jpeg: ByteArray?, fromProxy: Bitmap?, rotation: Int, sample: Int): Bitmap? =
        try {
            val source = when {
                jpeg != null -> {
                    val options = BitmapFactory.Options().apply {
                        inPreferredConfig = Bitmap.Config.ARGB_8888
                        inSampleSize = sample
                        // Converted, not relabelled, before any colour profile is left out.
                        if (Build.VERSION.SDK_INT >= 26) inPreferredColorSpace = ColorSpace.get(ColorSpace.Named.SRGB)
                    }
                    BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size, options)
                }
                fromProxy != null && sample == 1 -> fromProxy
                fromProxy != null -> fromProxy.scale(maxOf(1, fromProxy.width / sample), maxOf(1, fromProxy.height / sample))
                else -> null
            }
            // The camera's own bitmap is kept for the half-size retry; anything decoded here
            // is freed at once if turning it runs out of memory.
            source?.let { rotate(it, rotation, freeOnFailure = it !== fromProxy) }
        } catch (_: OutOfMemoryError) {
            null
        }

    private fun rotate(source: Bitmap, degrees: Int, freeOnFailure: Boolean): Bitmap {
        if (degrees % 360 == 0) return source
        val matrix = Matrix().apply { postRotate(degrees.toFloat()) }
        val turned = try {
            Bitmap.createBitmap(source, 0, 0, source.width, source.height, matrix, true)
        } catch (e: OutOfMemoryError) {
            // About 49 MB for a 12-megapixel picture: freed now rather than at the next
            // garbage collection, so the half-size retry has the memory.
            if (freeOnFailure) source.recycle()
            throw e
        }
        if (turned !== source) source.recycle()
        return turned
    }

    // ---------------------------------------------------------------- screen

    private fun close() {
        cancelled = true
        setResult(RESULT_CANCELED)
        finish()
    }

    private fun setControlsEnabled(enabled: Boolean) {
        shutter.isEnabled = enabled
        // The shutter turns grey through its own drawable; the two small buttons fade.
        val alpha = if (enabled) 1f else DISABLED_ALPHA
        switchButton.isEnabled = enabled
        switchButton.alpha = alpha
        flashButton.isEnabled = enabled
        flashButton.alpha = alpha
    }

    private fun showStatus(message: Int?) {
        if (message == null) {
            status.text = ""
            status.visibility = View.GONE
        } else {
            status.setText(message)
            status.visibility = View.VISIBLE
        }
    }

    /** A 100 ms white flash on the screen when the photo is taken. */
    private fun flashScreen() {
        flashOverlay.animate().cancel()
        flashOverlay.alpha = 1f
        flashOverlay.visibility = View.VISIBLE
        flashOverlay.animate().alpha(0f).setDuration(FLASH_MS).withEndAction { flashOverlay.visibility = View.GONE }.start()
    }

    /** Edge to edge: the bars and the panel keep clear of the system bars and the cut-out. */
    private fun applyInsets() {
        val top = Padding(topBar)
        val bottom = Padding(bottomBar)
        val content = Padding(panelContent)
        ViewCompat.setOnApplyWindowInsetsListener(findViewById(android.R.id.content)) { _, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            top.apply(bars.left, bars.top, bars.right, 0)
            bottom.apply(bars.left, 0, bars.right, bars.bottom)
            content.apply(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
    }

    private class Padding(private val view: View) {
        private val left = view.paddingLeft
        private val top = view.paddingTop
        private val right = view.paddingRight
        private val bottom = view.paddingBottom

        fun apply(l: Int, t: Int, r: Int, b: Int) = view.setPadding(left + l, top + t, right + r, bottom + b)
    }

    companion object {
        /** The photo's UUID in the result; never a path. */
        const val EXTRA_PHOTO = "no.stormberry.metadatascrubber.extra.PHOTO"

        private val MAX_SIZE = Size(4032, 3024)
        private const val JPEG_QUALITY = 90
        private const val FLASH_MS = 100L
        private const val DISABLED_ALPHA = 0.4f

        private const val STATE_PANEL = "panel"
        private const val STATE_FRONT = "front"
        private const val STATE_FLASH = "flash"
    }
}
