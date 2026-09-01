/**
 * Transfer approval.
 *
 * Without this, anything on the same Wi-Fi that finds the port can push files
 * and the receiver saves them silently. The flow now is:
 *
 *   1. sender  POST /offer   {from, deviceId, files:[{name,size}]}
 *   2. receiver asks the user (unless the device is already trusted)
 *   3. sender  GET  /offer/:id   until accepted, then gets a one-use token
 *   4. sender  POST /upload?token=...
 *
 * A six-digit code is shown on both ends so the user can tell which device is
 * actually asking — names alone are trivially spoofable on a LAN.
 *
 * Note: this is authorisation, not authentication. Until transfers are over
 * TLS a determined attacker on your network can still impersonate a trusted
 * device. It stops silent drive-by transfers, which is the realistic risk.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const OFFER_TTL_MS = 2 * 60 * 1000; // an unanswered prompt expires
const TOKEN_TTL_MS = 5 * 60 * 1000; // time to actually start the upload

const offers = new Map(); // id -> offer
let trustedPath = null;
let trusted = new Map(); // deviceId -> {name, addedAt}

function init(userDataDir) {
  trustedPath = path.join(userDataDir, 'trusted-devices.json');
  try {
    const raw = JSON.parse(fs.readFileSync(trustedPath, 'utf8'));
    trusted = new Map(Object.entries(raw));
  } catch {
    trusted = new Map();
  }
}

function persistTrusted() {
  if (!trustedPath) return;
  try {
    fs.mkdirSync(path.dirname(trustedPath), { recursive: true });
    fs.writeFileSync(trustedPath, JSON.stringify(Object.fromEntries(trusted), null, 2));
  } catch {
    /* a failed write just means the trust doesn't survive a restart */
  }
}

const isTrusted = (deviceId) => !!deviceId && trusted.has(deviceId);

function trustDevice(deviceId, name) {
  if (!deviceId) return;
  trusted.set(deviceId, { name, addedAt: new Date().toISOString() });
  persistTrusted();
}

function listTrusted() {
  return [...trusted.entries()].map(([id, v]) => ({ id, ...v }));
}

function revokeTrust(deviceId) {
  trusted.delete(deviceId);
  persistTrusted();
}

function sweep() {
  const now = Date.now();
  for (const [id, o] of offers) {
    const dead =
      (o.status === 'pending' && now > o.createdAt + OFFER_TTL_MS) ||
      (o.status === 'accepted' && now > o.acceptedAt + TOKEN_TTL_MS) ||
      now > o.createdAt + OFFER_TTL_MS + TOKEN_TTL_MS;
    if (dead) offers.delete(id);
  }
}

/** Create an offer. Returns it immediately; approval resolves later. */
function createOffer({ from, deviceId, platform, files }) {
  sweep();
  const id = crypto.randomUUID();
  const offer = {
    id,
    from: from || 'Unknown device',
    deviceId: deviceId || null,
    platform: platform || '',
    files: Array.isArray(files) ? files : [],
    // Six digits, shown on both ends so the user knows which device is asking.
    code: String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'),
    status: 'pending',
    token: null,
    createdAt: Date.now(),
    acceptedAt: null,
    // Senders upload one file per request, so the token is good for exactly
    // as many uploads as the offer declared — no more.
    usesLeft: 0,
  };
  offers.set(id, offer);
  return offer;
}

function accept(id) {
  const offer = offers.get(id);
  if (!offer || offer.status !== 'pending') return null;
  offer.status = 'accepted';
  offer.token = crypto.randomBytes(24).toString('hex');
  offer.acceptedAt = Date.now();
  offer.usesLeft = Math.max(1, offer.files.length);
  return offer;
}

function decline(id) {
  const offer = offers.get(id);
  if (!offer || offer.status !== 'pending') return null;
  offer.status = 'declined';
  return offer;
}

function getOffer(id) {
  sweep();
  return offers.get(id) || null;
}

/**
 * Consume one use of a token. Bounded by the number of files the sender
 * declared, so an intercepted token can't be replayed indefinitely.
 */
function redeemToken(token) {
  if (!token) return null;
  sweep();
  for (const offer of offers.values()) {
    if (offer.status === 'accepted' && offer.token === token && offer.usesLeft > 0) {
      offer.usesLeft -= 1;
      if (offer.usesLeft === 0) offer.status = 'used';
      return offer;
    }
  }
  return null;
}

module.exports = {
  init,
  createOffer,
  accept,
  decline,
  getOffer,
  redeemToken,
  isTrusted,
  trustDevice,
  listTrusted,
  revokeTrust,
  OFFER_TTL_MS,
};
