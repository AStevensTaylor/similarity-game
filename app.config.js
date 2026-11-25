// Dynamic layer over app.json (app.json stays the base config; Expo passes it in as `config`).
//
// The release workflow (.github/workflows/release.yml) sets two environment variables before
// `expo prebuild`; with neither set, everything falls back to app.json, so local development
// needs no environment at all.
//
//   APP_VERSION       e.g. "1.2.3" or "1.2.3-rc.1"  (from the git tag)
//   APP_BUILD_NUMBER  positive integer              (the workflow run number)
module.exports = ({ config }) => {
  const version = process.env.APP_VERSION || config.version;
  const build = Number.parseInt(process.env.APP_BUILD_NUMBER || '', 10) || 1;
  return {
    ...config,
    version,
    // Android: versionName = version (any string), versionCode = build.
    android: { ...config.android, versionCode: build },
    ios: {
      ...config.ios,
      // CFBundleShortVersionString must be plain numeric x.y.z, so drop any "-rc.1" / "+meta".
      version: version.replace(/[-+].*$/, ''),
      buildNumber: String(build),
    },
    plugins: [...(config.plugins ?? []), './plugins/withAndroidReleaseSigning'],
  };
};
