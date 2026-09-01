/**
 * Build config lives here rather than in package.json because signing has to
 * be conditional: this machine may or may not have a Developer ID, and an
 * unsigned local build should still work with the same command.
 *
 * Set all three of APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID to
 * produce a signed, notarised, stapled dmg. Leave them unset and you get the
 * old unsigned build, which needs right-click → Open on first launch.
 */

const notarising = Boolean(
  process.env.APPLE_ID &&
    process.env.APPLE_APP_SPECIFIC_PASSWORD &&
    process.env.APPLE_TEAM_ID
);

if (!notarising) {
  console.warn(
    '[beam] APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID not set — ' +
      'building an UNSIGNED dmg. See docs/RELEASING.md.'
  );
}

module.exports = {
  appId: 'com.vicky.beam',
  productName: 'Beam',
  files: ['src/**/*', 'build/icon.icns'],
  directories: { output: 'release', buildResources: 'build' },
  mac: {
    category: 'public.app-category.utilities',
    target: [{ target: 'dmg', arch: ['arm64'] }],
    icon: 'build/icon.icns',
    // Notarisation requires the hardened runtime; the entitlements give back
    // what Electron actually needs under it.
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    notarize: notarising ? { teamId: process.env.APPLE_TEAM_ID } : false,
    extendInfo: {
      NSLocalNetworkUsageDescription:
        'Beam finds your phone on the local network to transfer files.',
      LSUIElement: false,
    },
  },
  dmg: { title: 'Beam ${version}' },
};
