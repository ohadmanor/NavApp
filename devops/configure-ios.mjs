#!/usr/bin/env node
/**
 * devops/configure-ios.mjs
 *
 * Automatically configures and hardens the Capacitor iOS Xcode project (`ios/App`):
 *  1. Removes any accidental `.apk` / `.ipa` / `.xcarchive` files from `ios/App/App/public`.
 *  2. Updates `ios/App/App/Info.plist` with:
 *     - Display name (`NavApp Israel Outdoor`)
 *     - Hebrew + English GPS location permission descriptions (WhenInUse & AlwaysAndWhenInUse)
 *     - Background location mode (`UIBackgroundModes -> location`) for locked-screen track recording
 *     - Files app document access (`UIFileSharingEnabled`, `LSSupportsOpeningDocumentsInPlace`)
 *     - App Store export compliance (`ITSAppUsesNonExemptEncryption = false`)
 *     - App Transport Security (`NSAppTransportSecurity` enforcing HTTPS + allowing local networking)
 *     - Localizations (`he`, `en`)
 *  3. Syncs `MARKETING_VERSION` (from `package.json`) and optional `IOS_BUILD_NUMBER` into
 *     `ios/App/App.xcodeproj/project.pbxproj`.
 *  4. Converts `public/icon-512.png` to an opaque 1024x1024 RGB PNG at
 *     `ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png` when needed.
 *  5. Optionally generates `ios/App/ExportOptions.plist` when `IOS_TEAM_ID` is provided.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const IOS_DIR = path.join(ROOT_DIR, 'ios');
const IOS_APP_DIR = path.join(IOS_DIR, 'App');
const INFO_PLIST_PATH = path.join(IOS_APP_DIR, 'App', 'Info.plist');
const PBXPROJ_PATH = path.join(IOS_APP_DIR, 'App.xcodeproj', 'project.pbxproj');
const PUBLIC_ASSETS_DIR = path.join(IOS_APP_DIR, 'App', 'public');
const APP_ICON_TARGET = path.join(
  IOS_APP_DIR,
  'App',
  'Assets.xcassets',
  'AppIcon.appiconset',
  'AppIcon-512@2x.png'
);
const SOURCE_ICON = path.join(ROOT_DIR, 'public', 'icon-512.png');

function readPackageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf-8'));
    const raw = String(pkg.version || '0.5.0').trim();
    const match = /^\d+\.\d+\.\d+/.exec(raw);
    return match ? match[0] : '0.5.0';
  } catch {
    return '0.5.0';
  }
}

function readPngMetadata(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const buf = fs.readFileSync(filePath);
  if (buf.length < 26 || buf.toString('ascii', 1, 4) !== 'PNG') return null;
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    colorType: buf[25], // 2 = RGB (no alpha), 6 = RGBA
  };
}

function removeAccidentalBundledPackages() {
  const dirs = [path.join(ROOT_DIR, 'dist'), PUBLIC_ASSETS_DIR];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      const lower = entry.toLowerCase();
      if (lower.endsWith('.apk') || lower.endsWith('.ipa') || lower.endsWith('.xcarchive')) {
        fs.unlinkSync(path.join(dir, entry));
        console.log(`[iOS Config] Removed accidental bundled archive from ${path.relative(ROOT_DIR, dir)}: ${entry}`);
      }
    }
  }
}

function upsertPlistEntry(plistXml, key, valueXml) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const keyPattern = new RegExp(
    `([ \\t]*)<key>${escapedKey}<\\/key>\\s*(?:<dict>[\\s\\S]*?<\\/dict>|<array>[\\s\\S]*?<\\/array>|<string>[\\s\\S]*?<\\/string>|<true\\/>|<false\\/>)`,
    'm'
  );

  const formattedValue = valueXml
    .split('\n')
    .map((line, idx) => (idx === 0 ? line : `\t${line}`))
    .join('\n');

  if (keyPattern.test(plistXml)) {
    return plistXml.replace(keyPattern, `\t<key>${key}</key>\n\t${formattedValue}`);
  }

  return plistXml.replace(
    /<\/dict>\s*<\/plist>\s*$/,
    `\t<key>${key}</key>\n\t${formattedValue}\n</dict>\n</plist>\n`
  );
}

function configureInfoPlist() {
  if (!fs.existsSync(INFO_PLIST_PATH)) {
    console.warn(`[iOS Config] Info.plist not found at ${INFO_PLIST_PATH}`);
    return;
  }

  let plist = fs.readFileSync(INFO_PLIST_PATH, 'utf-8');

  plist = upsertPlistEntry(
    plist,
    'CFBundleDisplayName',
    '<string>NavApp Israel Outdoor</string>'
  );

  plist = upsertPlistEntry(
    plist,
    'NSLocationWhenInUseUsageDescription',
    '<string>NavApp משתמשת במיקום ה-GPS שלך להצגת מיקומך על המפה הטופוגרפית, ניווט שטח והקלטת מסלולים. / NavApp uses your GPS location to show your position on the topographic map, navigate trails, and record tracks.</string>'
  );

  plist = upsertPlistEntry(
    plist,
    'NSLocationAlwaysAndWhenInUseUsageDescription',
    '<string>NavApp זקוקה לגישה למיקום ברקע כדי להמשיך להקליט את מסלול הטיול ולנווט גם כשהמסך כבוי. / NavApp uses background location to continue recording your outdoor track when the screen is locked.</string>'
  );

  plist = upsertPlistEntry(
    plist,
    'UIBackgroundModes',
    `<array>\n\t<string>location</string>\n</array>`
  );

  plist = upsertPlistEntry(plist, 'UIFileSharingEnabled', '<true/>');
  plist = upsertPlistEntry(plist, 'LSSupportsOpeningDocumentsInPlace', '<true/>');
  plist = upsertPlistEntry(plist, 'ITSAppUsesNonExemptEncryption', '<false/>');

  plist = upsertPlistEntry(
    plist,
    'CFBundleLocalizations',
    `<array>\n\t<string>he</string>\n\t<string>en</string>\n</array>`
  );

  plist = upsertPlistEntry(
    plist,
    'NSAppTransportSecurity',
    `<dict>\n\t<key>NSAllowsArbitraryLoads</key>\n\t<false/>\n\t<key>NSAllowsLocalNetworking</key>\n\t<true/>\n</dict>`
  );

  fs.writeFileSync(INFO_PLIST_PATH, plist, 'utf-8');
  console.log('[iOS Config] Updated Info.plist (GPS permissions, background location, Files sharing, ATS, localizations)');
}

function syncXcodeProjectVersion() {
  if (!fs.existsSync(PBXPROJ_PATH)) return;
  const marketingVersion = readPackageVersion();
  const buildNumber = String(process.env.IOS_BUILD_NUMBER || '').trim();

  let pbx = fs.readFileSync(PBXPROJ_PATH, 'utf-8');
  pbx = pbx.replace(
    /MARKETING_VERSION = [^;]+;/g,
    `MARKETING_VERSION = ${marketingVersion};`
  );
  if (/^\d+$/.test(buildNumber)) {
    pbx = pbx.replace(
      /CURRENT_PROJECT_VERSION = [^;]+;/g,
      `CURRENT_PROJECT_VERSION = ${buildNumber};`
    );
  }
  fs.writeFileSync(PBXPROJ_PATH, pbx, 'utf-8');
  console.log(
    `[iOS Config] Synced Xcode MARKETING_VERSION=${marketingVersion}` +
      (/^\d+$/.test(buildNumber) ? `, CURRENT_PROJECT_VERSION=${buildNumber}` : '')
  );
}

function generateAppIcon1024() {
  if (!fs.existsSync(SOURCE_ICON) || !fs.existsSync(path.dirname(APP_ICON_TARGET))) {
    return;
  }

  let converted = false;
  if (process.platform === 'win32') {
    try {
      const psScript = [
        'Add-Type -AssemblyName System.Drawing;',
        `$src = [System.Drawing.Image]::FromFile('${SOURCE_ICON.replace(/'/g, "''")}');`,
        '$bmp = New-Object System.Drawing.Bitmap(1024, 1024, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb);',
        '$g = [System.Drawing.Graphics]::FromImage($bmp);',
        '$g.Clear([System.Drawing.Color]::FromArgb(15, 23, 42));',
        '$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic;',
        '$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality;',
        '$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality;',
        '$g.DrawImage($src, 0, 0, 1024, 1024);',
        `$bmp.Save('${APP_ICON_TARGET.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png);`,
        '$g.Dispose(); $bmp.Dispose(); $src.Dispose();',
      ].join(' ');
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
        stdio: 'pipe',
      });
      converted = true;
    } catch (err) {
      console.warn('[iOS Config] PowerShell icon conversion failed:', err.message);
    }
  } else if (process.platform === 'darwin') {
    try {
      const tmpAlpha = `${APP_ICON_TARGET}.tmp.png`;
      execFileSync('sips', ['-z', '1024', '1024', SOURCE_ICON, '--out', tmpAlpha], {
        stdio: 'pipe',
      });
      // Strip alpha by converting via sips to bmp then back to png (ensures colorType 2 opaque RGB)
      const tmpBmp = `${APP_ICON_TARGET}.tmp.bmp`;
      execFileSync('sips', ['-s', 'format', 'bmp', tmpAlpha, '--out', tmpBmp], { stdio: 'pipe' });
      execFileSync('sips', ['-s', 'format', 'png', tmpBmp, '--out', APP_ICON_TARGET], {
        stdio: 'pipe',
      });
      fs.rmSync(tmpAlpha, { force: true });
      fs.rmSync(tmpBmp, { force: true });
      converted = true;
    } catch (err) {
      console.warn('[iOS Config] macOS sips icon conversion failed:', err.message);
    }
  }

  if (converted) {
    const finalMeta = readPngMetadata(APP_ICON_TARGET);
    console.log(
      `[iOS Config] Generated 1024x1024 AppIcon from public/icon-512.png (${finalMeta?.width}x${finalMeta?.height}, colorType=${finalMeta?.colorType})`
    );
  }
}

function writeExportOptionsIfConfigured() {
  const teamId = String(process.env.IOS_TEAM_ID || '').trim();
  if (!teamId || !fs.existsSync(IOS_APP_DIR)) return;

  const method = String(process.env.IOS_EXPORT_METHOD || 'ad-hoc').trim();
  const exportPlistPath = path.join(IOS_APP_DIR, 'ExportOptions.plist');
  const exportPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>method</key>
\t<string>${method}</string>
\t<key>teamID</key>
\t<string>${teamId}</string>
\t<key>signingStyle</key>
\t<string>automatic</string>
\t<key>compileBitcode</key>
\t<false/>
\t<key>stripSwiftSymbols</key>
\t<true/>
</dict>
</plist>
`;
  fs.writeFileSync(exportPlistPath, exportPlist, 'utf-8');
  console.log(`[iOS Config] Generated ios/App/ExportOptions.plist (method=${method}, teamID=${teamId})`);
}

function main() {
  if (!fs.existsSync(IOS_DIR)) {
    console.log('[iOS Config] ios/ directory does not exist yet. Run `npx cap add ios` first.');
    return;
  }
  removeAccidentalBundledPackages();
  configureInfoPlist();
  syncXcodeProjectVersion();
  generateAppIcon1024();
  writeExportOptionsIfConfigured();
}

main();
