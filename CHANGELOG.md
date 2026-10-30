# Changelog

MetadataScrubber for Android, newest first. The release text of each version, which GitHub Releases and Zapstore show, is in `fastlane/metadata/android/en-US/changelogs/<versionCode>.txt` (from 0.0.2). The app runs the same files as the website, metadata.stormberry.as, which is published from the same repository; from 1.0.0 the Google Play edition (`no.stormberry.metadatascrubber.play`) carries the same version name, with versionCode 1000 plus the one below.

## 1.1.1 (versionCode 7)

- Save writes the new file over an existing one whole, or not at all. The app first asks the storage app to write and truncate (`"wt"`). A storage app that refuses that gets a plain write (`"w"`), which some storage apps do not truncate; the app then checks that the file is exactly as long as the new picture, and otherwise the save fails, the mixed file is removed and the app says so. Saving over an older, longer file (a Motion Photo, whose video has its own details) can no longer leave that file's end after the clean picture. Either way, a save in which fewer bytes than the new picture's length were written fails too. A file you chose to replace is deleted after a failure only once the app has opened it for writing; before that only an empty file is removed, such as the one the save screen made (`SaveTarget.kt`, the same logic as CheckLink's, with its own tests). Android's own storage accepts `"wt"`, so on most phones nothing changes.
- The app bundles the website as it now stands, among it the engine fix of 16 October 2026: text stored under names such as `constructor`, `__proto__`, `toString` or `valueOf` in PNG text or XMP is now found and removed (such names matched inherited properties of plain objects before). Also bundled: a verse at the head of every page, the iPhone Home Screen icon, CheckLink in the carousel. The JavaScript is now type-checked in development (`npm run typecheck`); the checker is not part of the app.
- Still one permission, the camera, and no internet access.

## 1.1.0 (versionCode 6), 2026-10-12

Take a photo in the app: a simple camera with a shutter, a front or back switch, flash where there is one, and pinch to zoom. The photo is made without a location or device details, is not added to your gallery, and goes straight to Save, Copy and Share. The app now asks for one permission, the camera, and only when you tap Take a photo. It still has no internet access. The app's copy of a shared picture is now deleted after 10 minutes. On the website, phones and tablets get Take a photo too.

## 1.0.1 (versionCode 5), 2026-10-06

The app now has the website's buttons under each new picture. Save only saves. Copy image puts a copy without file details on the clipboard; it can be pasted for 2 minutes, then the app deletes it and says so. Share the new image opens Android's share sheet at once, with the warning always under it. The HDR gain map's note now says it is a second, smaller picture of the scene that may still show what you edited or blurred in another app.

## 1.0.0 (versionCode 4), 2026-10-05

Share with care: the app's Share now warns first that once a picture is online, you cannot take it back. On the website, Share the new image and Copy image (no file details) sit under Save, with the same warning. A note says when your choices may make colours look a little duller and bright areas less vivid on HDR screens. New privacy page, also in the app. Fix: HDR photos from recent iPhones keep their HDR brightness again.

## 0.0.3 (versionCode 3), 2026-10-04

Only red details are ticked to start with; amber (dates, camera, lens, software) is kept unless you tick it, and holds only values of the expected form. Captions, titles, descriptions, keywords, comments and Content Credentials are red, as they can name people. HDR JPEGs and iPhone HEICs keep their gain map and HDR brightness. XMP, IPTC and PNG text that stay are rewritten in a standard form. Green keeps only numbers, fixed words and known profile names.

## 0.0.2 (versionCode 2), 2026-10-03

Details now sit in Red, Amber and Green sections that start closed. Red and amber details are ticked for removal to start with; green is kept. Tick a whole colour at once, or open it to choose single details. The result button now names the file, for example Save image.minimal.jpg.

## 0.0.1 (versionCode 1), 2026-10-03

First Android release: the website's engine in an app, copied byte for byte into the APK and run offline. No permissions at all, no internet access. Pictures come in through the system file picker or a share from your gallery, and the clean copy goes out through Save or Share.
