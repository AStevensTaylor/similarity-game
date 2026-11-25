// Expo config plugin: sign the Android release build with a real keystore when one is
// supplied through environment variables, otherwise keep the template's debug keystore.
//
//   ANDROID_KEYSTORE_FILE      absolute path to the .jks / .p12 keystore
//   ANDROID_KEYSTORE_PASSWORD  keystore password
//   ANDROID_KEY_ALIAS          key alias
//   ANDROID_KEY_PASSWORD       key password (optional; defaults to the keystore password)
//
// The variables are read by Gradle at BUILD time, not at prebuild time, so nothing secret is
// ever written into android/app/build.gradle.
const { withAppBuildGradle } = require('expo/config-plugins');

const MARKER = '// @generated withAndroidReleaseSigning';

const HEADER = `${MARKER}
def releaseKeystoreFile = System.getenv('ANDROID_KEYSTORE_FILE') ?: ''
def hasReleaseKeystore = !releaseKeystoreFile.isEmpty() && new File(releaseKeystoreFile).exists()
println(hasReleaseKeystore
    ? '[signing] release build signed with the keystore from ANDROID_KEYSTORE_FILE'
    : '[signing] no release keystore supplied: release build signed with the public DEBUG key')

`;

const RELEASE_SIGNING_CONFIG = `
        release {
            if (hasReleaseKeystore) {
                storeFile new File(releaseKeystoreFile)
                storePassword System.getenv('ANDROID_KEYSTORE_PASSWORD')
                keyAlias System.getenv('ANDROID_KEY_ALIAS')
                keyPassword System.getenv('ANDROID_KEY_PASSWORD') ?: System.getenv('ANDROID_KEYSTORE_PASSWORD')
            }
        }`;

function replaceOnce(source, pattern, replacement, what) {
  if (!pattern.test(source)) {
    throw new Error(`withAndroidReleaseSigning: could not find ${what} in android/app/build.gradle`);
  }
  return source.replace(pattern, replacement);
}

module.exports = function withAndroidReleaseSigning(config) {
  return withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== 'groovy') {
      throw new Error('withAndroidReleaseSigning: android/app/build.gradle is not Groovy');
    }
    let src = cfg.modResults.contents;
    if (src.includes(MARKER)) return cfg;

    // 1. release build type: pick the release signing config when a keystore was supplied.
    src = replaceOnce(
      src,
      /(buildTypes\s*\{[\s\S]*?release\s*\{[^}]*?signingConfig\s+)signingConfigs\.debug/,
      '$1(hasReleaseKeystore ? signingConfigs.release : signingConfigs.debug)',
      'the release signingConfig',
    );
    // 2. declare signingConfigs.release next to signingConfigs.debug.
    src = replaceOnce(
      src,
      /(signingConfigs\s*\{\s*debug\s*\{[^}]*\})/,
      `$1${RELEASE_SIGNING_CONFIG}`,
      'signingConfigs.debug',
    );
    // 3. the two definitions used above, placed just before the android { } block.
    src = replaceOnce(src, /^android\s*\{/m, `${HEADER}android {`, 'the android block');

    cfg.modResults.contents = src;
    return cfg;
  });
};
