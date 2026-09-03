const { execFileSync } = require('node:child_process');
const path = require('node:path');

// Free macOS release route: sign the completed Electron bundle with Apple's
// ad-hoc identity before electron-builder creates the DMG and ZIP. This makes
// the bundle runnable on Apple Silicon without asking each user to run codesign.
// It does not provide Developer ID trust or Apple notarization.
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin' || process.platform !== 'darwin') return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);

  execFileSync('/usr/bin/codesign', [
    '--force',
    '--deep',
    '--sign',
    '-',
    appPath
  ], { stdio: 'inherit' });

  execFileSync('/usr/bin/codesign', [
    '--verify',
    '--deep',
    '--strict',
    '--verbose=2',
    appPath
  ], { stdio: 'inherit' });
};
