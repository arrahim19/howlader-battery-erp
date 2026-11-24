import type { ExpoConfig } from "expo/config";
import { withAppBuildGradle, type ConfigPlugin } from "expo/config-plugins";

const withLocalSigning: ConfigPlugin = (app) =>
  withAppBuildGradle(app, (mod) => {
    const marker = "// Hawlader local release signing";
    const previousSigningBlock =
      /\/\/ Hawlader local release signing[\s\S]*?\/\/ End Hawlader local release signing\r?\n?/g;
    mod.modResults.contents =
      mod.modResults.contents.replace(previousSigningBlock, "").trimEnd() +
      `
${marker}
// DOM JavaScript must be minified too; Hermes alone only optimizes the native bundle.
afterEvaluate {
  tasks.withType(com.facebook.react.tasks.BundleHermesCTask).configureEach {
    minifyEnabled.set(true)
  }
}
def hawladerKeystore = System.getenv('HAWLADER_LOCAL_KEYSTORE_FILE')
if (hawladerKeystore) {
  android {
    defaultConfig {
      externalNativeBuild { cmake { arguments '-DCMAKE_OBJECT_PATH_MAX=240' } }
    }
    signingConfigs {
      localRelease {
        storeFile file(hawladerKeystore)
        storePassword System.getenv('HAWLADER_LOCAL_STORE_PASSWORD')
        keyAlias System.getenv('HAWLADER_LOCAL_KEY_ALIAS')
        keyPassword System.getenv('HAWLADER_LOCAL_KEY_PASSWORD')
      }
    }
    buildTypes { release { signingConfig signingConfigs.localRelease } }
  }
}
// End Hawlader local release signing
`;
    return mod;
  });

const production = process.env.APP_VARIANT === "production";
const config: ExpoConfig = {
  name: "Howlader Battery",
  slug: "hawlader-battery-erp",
  owner: "arrahim19",
  scheme: "hawladerbattery",
  version: "1.0.10",
  orientation: "portrait",
  userInterfaceStyle: "light",
  icon: "./assets/icon.png",
  android: {
    package: "com.hawlader.batteryerp",
    versionCode: 11,
    adaptiveIcon: {
      foregroundImage: "./assets/adaptive-icon.png",
      backgroundColor: "#ffffff",
    },
    predictiveBackGestureEnabled: true,
  },
  plugins: [
    "expo-router",
    "expo-secure-store",
    "expo-sqlite",
    [
      "expo-splash-screen",
      {
        image: "./assets/splash-icon.png",
        imageWidth: 100,
        backgroundColor: "#ffffff",
      },
    ],
    [
      "expo-build-properties",
      {
        android: {
          usesCleartextTraffic: !production,
          enableMinifyInReleaseBuilds: true,
          enableShrinkResourcesInReleaseBuilds: true,
          enableBundleCompression: true,
          useLegacyPackaging: false,
          networkInspector: false,
        },
      },
    ],
  ],
  web: { bundler: "metro", output: "single", favicon: "./assets/icon.png" },
  extra: {
    production,
    eas: { projectId: "21e4c3ea-3391-4abf-8503-55b8db156de6" },
  },
};
export default withLocalSigning(config);
