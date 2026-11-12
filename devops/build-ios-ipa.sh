#!/usr/bin/env bash
# ============================================================================
# devops/build-ios-ipa.sh
#
# Full macOS iOS builder for NavApp Israel Outdoor:
#   1. Generates offline assets, PMTiles search index, and production web bundle
#   2. Ensures @capacitor/ios is installed and syncs ios/App
#   3. Configures Info.plist (GPS, background location, ATS, AppIcon, version)
#   4. Installs CocoaPods dependencies (pod install)
#   5. Compiles via xcodebuild into:
#        - dist/NavApp-Israel-Release.ipa    (when IOS_TEAM_ID is set)
#        - dist/NavApp-Israel-Unsigned.ipa   (default --unsigned mode)
#        - dist/NavApp-Israel-Simulator.app.zip (when --simulator is passed)
#
# Usage:
#   bash devops/build-ios-ipa.sh                     # Unsigned .ipa (or signed if IOS_TEAM_ID is set)
#   bash devops/build-ios-ipa.sh --unsigned          # Force unsigned Release .ipa
#   bash devops/build-ios-ipa.sh --simulator         # Build iOS Simulator .app.zip
#   IOS_TEAM_ID=ABCDE12345 bash devops/build-ios-ipa.sh --ad-hoc
#   IOS_TEAM_ID=ABCDE12345 bash devops/build-ios-ipa.sh --app-store
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}"

MODE="auto"
for arg in "$@"; do
  case "$arg" in
    --simulator) MODE="simulator" ;;
    --unsigned)  MODE="unsigned" ;;
    --signed|--ad-hoc) MODE="ad-hoc" ;;
    --app-store) MODE="app-store" ;;
    --development) MODE="development" ;;
    -h|--help)
      sed -n '2,23p' "$0"
      exit 0
      ;;
    *)
      echo "[ERROR] Unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[ERROR] Building an iOS .ipa requires macOS with Xcode installed." >&2
  echo "        On Windows, run devops\\build-ios.bat to prepare ios/App, or use .github/workflows/build-ios.yml." >&2
  exit 1
fi

if ! command -v xcodebuild >/dev/null 2>&1; then
  echo "[ERROR] xcodebuild not found. Install Xcode and run: sudo xcode-select -s /Applications/Xcode.app" >&2
  exit 1
fi

if [[ "${MODE}" == "auto" ]]; then
  if [[ -n "${IOS_TEAM_ID:-}" ]]; then
    MODE="${IOS_EXPORT_METHOD:-ad-hoc}"
  else
    MODE="unsigned"
  fi
fi

echo "============================================================================"
echo "  NavApp - iOS Builder (mode: ${MODE})"
echo "  Working Directory: ${ROOT_DIR}"
echo "============================================================================"

echo "[1/5] Generating offline assets, PMTiles search index, and building web bundle..."
rm -f dist/*.apk dist/*.ipa dist/*.app.zip
node devops/build-pmtiles-search-index.mjs --if-present --if-stale
node devops/generate-offline-assets.mjs
npm run build

mkdir -p dist/data
if [[ -f data/Israel.pois.geojson ]]; then cp -f data/Israel.pois.geojson dist/data/Israel.pois.geojson; fi
if [[ -f data/Israel.offroad.pois.geojson ]]; then cp -f data/Israel.offroad.pois.geojson dist/data/Israel.offroad.pois.geojson; fi
if [[ -f data/Israel.search.idx ]]; then cp -f data/Israel.search.idx dist/data/Israel.search.idx; fi

echo "[2/5] Syncing web bundle with Capacitor iOS native project..."
if [[ ! -d node_modules/@capacitor/ios ]]; then
  npm install @capacitor/ios@^7.6.10
fi
if [[ ! -d ios ]]; then
  npx cap add ios
fi
npx cap sync ios

echo "[3/5] Applying iOS Info.plist, permissions, ATS security, version & AppIcon..."
if [[ "${MODE}" != "unsigned" && "${MODE}" != "simulator" ]]; then
  export IOS_EXPORT_METHOD="${MODE}"
fi
node devops/configure-ios.mjs

echo "[4/5] Installing CocoaPods dependencies..."
cd "${ROOT_DIR}/ios/App"
if [[ -f Podfile ]]; then
  if command -v pod >/dev/null 2>&1; then
    pod install
  else
    echo "[WARN] CocoaPods ('pod') not found. Skipping pod install (Workspace builds may fail if Pods are missing)."
  fi
fi

BUILD_DIR="${ROOT_DIR}/ios/App/build"
rm -rf "${BUILD_DIR}"
mkdir -p "${BUILD_DIR}"

WORKSPACE_OR_PROJECT=()
if [[ -d App.xcworkspace ]]; then
  WORKSPACE_OR_PROJECT=(-workspace App.xcworkspace)
else
  WORKSPACE_OR_PROJECT=(-project App.xcodeproj)
fi

echo "[5/5] Building iOS binary via xcodebuild (${MODE})..."
if [[ "${MODE}" == "simulator" ]]; then
  xcodebuild "${WORKSPACE_OR_PROJECT[@]}" \
    -scheme App \
    -configuration Release \
    -sdk iphonesimulator \
    -destination 'generic/platform=iOS Simulator' \
    -derivedDataPath "${BUILD_DIR}/DerivedData" \
    CODE_SIGNING_ALLOWED=NO \
    build

  APP_PATH="${BUILD_DIR}/DerivedData/Build/Products/Release-iphonesimulator/App.app"
  if [[ ! -d "${APP_PATH}" ]]; then
    echo "[ERROR] Simulator App.app not found at ${APP_PATH}" >&2
    exit 1
  fi
  OUT_ZIP="${ROOT_DIR}/dist/NavApp-Israel-Simulator.app.zip"
  (cd "$(dirname "${APP_PATH}")" && zip -r -q "${OUT_ZIP}" "App.app")
  echo ""
  echo "============================================================================"
  echo "  [SUCCESS] iOS Simulator app ready:"
  echo "  ${OUT_ZIP}"
  echo "============================================================================"
elif [[ "${MODE}" == "unsigned" ]]; then
  ARCHIVE_PATH="${BUILD_DIR}/NavApp.xcarchive"
  xcodebuild "${WORKSPACE_OR_PROJECT[@]}" \
    -scheme App \
    -configuration Release \
    -sdk iphoneos \
    -destination 'generic/platform=iOS' \
    -archivePath "${ARCHIVE_PATH}" \
    CODE_SIGN_IDENTITY="" \
    CODE_SIGNING_REQUIRED=NO \
    CODE_SIGNING_ALLOWED=NO \
    archive

  APP_PATH="${ARCHIVE_PATH}/Products/Applications/App.app"
  if [[ ! -d "${APP_PATH}" ]]; then
    echo "[ERROR] Archived App.app not found at ${APP_PATH}" >&2
    exit 1
  fi

  PAYLOAD_DIR="${BUILD_DIR}/ipa-stage/Payload"
  rm -rf "${BUILD_DIR}/ipa-stage"
  mkdir -p "${PAYLOAD_DIR}"
  cp -R "${APP_PATH}" "${PAYLOAD_DIR}/App.app"
  OUT_IPA="${ROOT_DIR}/dist/NavApp-Israel-Unsigned.ipa"
  (cd "${BUILD_DIR}/ipa-stage" && zip -r -q "${OUT_IPA}" "Payload")

  echo ""
  echo "============================================================================"
  echo "  [SUCCESS] Unsigned iOS IPA ready (sideload/re-sign via AltStore/Sideloadly):"
  echo "  ${OUT_IPA}"
  echo "============================================================================"
else
  if [[ -z "${IOS_TEAM_ID:-}" ]]; then
    echo "[ERROR] Signed export (${MODE}) requires IOS_TEAM_ID environment variable." >&2
    exit 1
  fi

  ARCHIVE_PATH="${BUILD_DIR}/NavApp.xcarchive"
  EXPORT_DIR="${BUILD_DIR}/export"
  xcodebuild "${WORKSPACE_OR_PROJECT[@]}" \
    -scheme App \
    -configuration Release \
    -sdk iphoneos \
    -destination 'generic/platform=iOS' \
    -archivePath "${ARCHIVE_PATH}" \
    DEVELOPMENT_TEAM="${IOS_TEAM_ID}" \
    -allowProvisioningUpdates \
    archive

  xcodebuild -exportArchive \
    -archivePath "${ARCHIVE_PATH}" \
    -exportPath "${EXPORT_DIR}" \
    -exportOptionsPlist "${ROOT_DIR}/ios/App/ExportOptions.plist" \
    -allowProvisioningUpdates

  BUILT_IPA="$(find "${EXPORT_DIR}" -maxdepth 1 -name '*.ipa' | head -n 1)"
  if [[ -z "${BUILT_IPA}" || ! -f "${BUILT_IPA}" ]]; then
    echo "[ERROR] Exported .ipa not found in ${EXPORT_DIR}" >&2
    exit 1
  fi

  OUT_IPA="${ROOT_DIR}/dist/NavApp-Israel-Release.ipa"
  cp -f "${BUILT_IPA}" "${OUT_IPA}"
  echo ""
  echo "============================================================================"
  echo "  [SUCCESS] Signed iOS IPA (${MODE}) ready:"
  echo "  ${OUT_IPA}"
  echo "============================================================================"
fi
