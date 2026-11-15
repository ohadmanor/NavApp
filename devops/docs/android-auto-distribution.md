# Distributing NavApp for Android Auto (Play Store & Sideloading)

Android Auto (`com.google.android.projection.gearhead`) enforces an installer-provenance check on all unrooted Android phones: **only apps installed from the Google Play Store (`com.android.vending`) appear automatically in Android Auto** without Developer Mode or ADB workarounds.

---

## Option 1: Seamless "Just Works" Distribution — Google Play Internal Testing (Recommended)

For you and invited testers to install NavApp normally (no USB cable, no ADB, no Developer Mode, and no public Play Store review):

1. **Create a Google Play Developer account** ($25 USD one-time fee).
2. **Create the app in Google Play Console** using application ID `com.navapp.outdoor.israel`.
3. **Enable the Android Auto form factor:**
   - In Play Console go to **Test and release → Setup → Advanced settings → Form factors → Add form factor → Android Auto** and accept the Android Auto addendum.
4. **Build a signed Android App Bundle (`.aab`)** instead of an `.apk`:
   ```bat
   npm run build
   npx cap sync android
   node devops\configure-android-security.mjs
   cd android
   gradlew.bat bundleRelease
   ```
   - Output: `android/app/build/outputs/bundle/release/app-release.aab`
   - Signed with `devops/keystore/navapp-release.jks` (**back up this keystore** — Google Play permanently ties your app / upload key to it).
   - `android/app/build.gradle` already targets SDK 35 (meets Play Console requirements). Increment `versionCode` in `android/app/build.gradle` before each new upload.
5. **Upload to Internal Testing:**
   - Go to **Testing → Internal testing** in Play Console, upload `app-release.aab`, add your tester Gmail address(es), and publish to Internal Testing (available within minutes with **no Play Store review wait**).
6. **Install on your phone:**
   - Open the Internal Testing opt-in URL on your phone and tap **Download on Google Play**.
   - Android Auto will immediately recognize NavApp on both your phone and car head unit.

---

## Option 2: Public Release on Google Play (Production)

To publish NavApp so any user can find and install it on Google Play for Android Auto:

1. Follow all steps in Option 1, then submit for Google Play's **Android Auto Navigation review**:
   - Add `androidx.car.app.action.NAVIGATE` (`geo:` scheme) intent handling in `android/app/src/main/AndroidManifest.xml` and `NavCarSession.java` (`NF-6` navigation-intent quality guideline).
   - Complete the Privacy Policy, Data Safety form, and Android Auto store-listing screenshots in Play Console.
   - For new personal Play Developer accounts, complete the required 14-day Closed Testing period before Production release.

---

## Option 3: Local Sideloading Without Google Play (Dev / Testing Only)

If you want to test local builds without Play Console:

- **Via USB or Wireless ADB (`devops/install-android-auto-apk.bat`):**
  ```bat
  adb install -i "com.android.vending" -r dist\NavApp-Israel-Signed-Release.apk
  ```
  (You can also pair/connect over Wi-Fi using Android **Settings → Developer options → Wireless debugging**.)
- **On-device without a PC:** Use **Shizuku** (via Wireless debugging) + **Install with Options** with the installer package set to `com.android.vending`.
- **One-time phone setup for sideloaded builds:**
  1. **Settings → Android Auto** → tap **Version** 10 times to unlock Developer Mode.
  2. Tap **⋮ → Developer settings** → enable **Unknown sources** and set **Application mode** to **Developer**.
  3. Open **NavApp** once on the phone before connecting to the car or Desktop Head Unit (DHU).
