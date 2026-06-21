// YHA Net background sync: peer manifests, membership, and update-status cache.
// @ts-nocheck
'use strict';

const path = require('node:path');
const { nowIso } = require('./net-identity');
const netModel = require('./net-model');
const versionInfo = require('./version-info');
const updateSource = require('./update-source');

const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const INSTALL_PATH = versionInfo.REPO_ROOT;

let buildSnapshot: any = {
  generatedAt: null,
  installPath: INSTALL_PATH,
  sshHost: null,
  version: null,
  commit: null,
  branch: null,
  describe: null,
  dirty: false,
  isRepo: false,
  updateStatus: null,
};

let syncTimer: ReturnType<typeof setInterval> | null = null;
let syncRunning = false;

function sshHostFromDetected(detected: any = {}) {
  const host = String(detected.tailscaleHost || detected.hostname || '').trim();
  return host || null;
}

function compactUpdateStatus(result: any = null) {
  if (!result || !result.success) return null;
  const mode = result.source?.mode === 'custom' ? 'custom' : 'standard';
  return {
    checkedAt: nowIso(),
    mode,
    sourceLabel: mode === 'custom' ? 'custom' : 'public',
    sourceDisplayUrl: result.source?.displayUrl || null,
    upToDate: !!result.upToDate,
    behind: Number(result.behind || 0),
    ahead: Number(result.ahead || 0),
    dirty: !!result.dirty,
    fetchOk: !!result.fetchOk,
    localVersion: result.localVersion || null,
    remoteVersion: result.remoteVersion || null,
    branch: result.branch || null,
    latestCommit: Array.isArray(result.commits) && result.commits[0] ? result.commits[0] : null,
  };
}

async function refreshBuildSnapshot(detected: any = {}) {
  const info = await versionInfo.getVersionInfo();
  let updateStatus = null;
  try {
    const checked = await versionInfo.checkForUpdates(updateSource.updateCheckBody());
    updateStatus = compactUpdateStatus(checked);
  } catch { /* best effort */ }
  const source = updateSource.publicUpdateSource();
  buildSnapshot = {
    generatedAt: nowIso(),
    installPath: INSTALL_PATH,
    sshHost: sshHostFromDetected(detected),
    updateSource: source,
    ...info,
    updateStatus,
  };
  return buildSnapshot;
}

function getBuildSnapshot() {
  return { ...buildSnapshot };
}

async function runNetSyncTick(detectedEndpointsFn: () => any) {
  if (syncRunning) return { skipped: true };
  syncRunning = true;
  try {
    const detected = detectedEndpointsFn();
    await refreshBuildSnapshot(detected);
    const selfUpdate = netModel.updateSelfEndpointsInNetworks(detected.endpoints || {});
    // If our own browser endpoints changed, push the corrected entry to peers
    // we can reach — they may only hold a stale (unreachable) endpoint for us,
    // so they can never pull our fresh manifest on their own.
    for (const networkId of (selfUpdate && selfUpdate.changed) || []) {
      try {
        const network = netModel.readNetwork(networkId);
        if (network) await netModel.propagateMembershipToMembers(network, []);
      } catch { /* peer unreachable — next tick retries */ }
    }
    netModel.hydrateAllNetworkEndpoints();
    netModel.reconcileNetworksFromManifests();
    await netModel.refreshMembershipFromPeers('');
    netModel.hydrateAllNetworkEndpoints();
    netModel.reconcileNetworksFromManifests();
    const networks = netModel.readNetworks();
    const results: any[] = [];
    for (const network of networks) {
      try {
        results.push(await netModel.refreshPeerManifests(network.id));
      } catch (e) {
        results.push({ networkId: network.id, error: e && e.message ? e.message : String(e) });
      }
    }
    netModel.reconcileNetworksFromManifests();
    return { ok: true, networks: networks.length, results, buildSnapshot: getBuildSnapshot() };
  } finally {
    syncRunning = false;
  }
}

function startNetBackgroundSync(detectedEndpointsFn: () => any) {
  if (syncTimer) return;
  const tick = () => {
    runNetSyncTick(detectedEndpointsFn).catch(() => {});
  };
  syncTimer = setInterval(tick, SYNC_INTERVAL_MS);
  setTimeout(tick, 20_000);
}

module.exports = {
  SYNC_INTERVAL_MS,
  INSTALL_PATH,
  refreshBuildSnapshot,
  getBuildSnapshot,
  runNetSyncTick,
  startNetBackgroundSync,
  sshHostFromDetected,
};