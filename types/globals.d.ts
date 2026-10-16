// Globals the served JavaScript uses but does not define. Type checking only, never served.

/** What the Android app's android-bridge.js (android/web-overlay/) adds to the page. */
interface MSAndroidApi {
  /** Hands the exact file to Android's share sheet; true once the app has done it. */
  share(file: Blob, name: string): Promise<boolean>;
  /** Hands a PNG to Android's clipboard; how long the copy can be pasted, or false. */
  copyImage(png: Blob): Promise<{ expiresIn: number } | false>;
  /** Opens the app's own camera screen; true when a photo is on its way. */
  takePhoto(): Promise<boolean>;
}

interface Window {
  /** Present only inside the Android app, and only when its message channel exists. */
  readonly MSAndroid?: MSAndroidApi;
}

interface WindowEventMap {
  /** Fired by android-bridge.js with the photo taken in the app's camera screen. */
  'msandroid:photo': CustomEvent<{ readonly file: File }>;
  /** Fired by android-bridge.js when the app ends a copied image's two minutes. */
  'msandroid:clip-expired': Event;
}
