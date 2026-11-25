# Android build environment for NixOS / nix.
#
#   nix-shell            # enter a shell with JDK 17 and the Android SDK/NDK
#   npx expo run:android # then build and install the development build
#
# Versions track what React Native 0.88 / Expo SDK 58 ask for
# (node_modules/react-native/gradle/libs.versions.toml).
#
# NOTE: evaluating this file accepts the Android SDK licence on your behalf
# (android_sdk.accept_license) and allows unfree packages for this shell only.
{
  pkgs ? import <nixpkgs> {
    config = {
      allowUnfree = true;
      android_sdk.accept_license = true;
    };
  },
  # The emulator and its system image need roughly 10 GB of free disk while nix unpacks them:
  #   nix-shell --arg withEmulator true
  withEmulator ? false,
}:

let
  buildToolsVersion = "37.0.0";
  ndkVersion = "27.1.12297006";
  cmakeVersion = "3.22.1";

  android = pkgs.androidenv.composeAndroidPackages {
    platformVersions = [
      "37.0"
      "36"
    ];
    buildToolsVersions = [
      buildToolsVersion
      "36.0.0"
    ];
    includeNDK = true;
    ndkVersions = [ ndkVersion ];
    includeCmake = true;
    cmakeVersions = [ cmakeVersion ];
    includeEmulator = withEmulator;
    includeSystemImages = withEmulator;
    systemImageTypes = [ "aosp_atd" ]; # slim headless-friendly image
    abiVersions = [ "x86_64" ];
    includeSources = false;
    includeExtras = [ ];
  };

  sdk = "${android.androidsdk}/libexec/android-sdk";
in
pkgs.mkShell {
  packages = [
    android.androidsdk
    pkgs.jdk17
    pkgs.nodejs_24
  ];

  ANDROID_HOME = sdk;
  ANDROID_SDK_ROOT = sdk;
  ANDROID_NDK_ROOT = "${sdk}/ndk/${ndkVersion}";
  JAVA_HOME = pkgs.jdk17.home;

  # Gradle normally downloads a prebuilt aapt2 that cannot run on NixOS; use the SDK's patched one.
  GRADLE_OPTS = "-Dorg.gradle.project.android.aapt2FromMavenOverride=${sdk}/build-tools/${buildToolsVersion}/aapt2";

  shellHook = ''
    export PATH="${sdk}/platform-tools:${sdk}/cmdline-tools/latest/bin:${sdk}/emulator:$PATH"
    # Keep emulator images and Gradle state out of the read-only store.
    export ANDROID_USER_HOME="''${ANDROID_USER_HOME:-$HOME/.android}"
    export ANDROID_AVD_HOME="$ANDROID_USER_HOME/avd"
  '';
}
