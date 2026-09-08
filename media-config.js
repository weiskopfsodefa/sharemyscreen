import { PLAYOUT_TARGET_MS } from './public/js/media-options.js';
import { AccessToken, TrackSource, RoomConfiguration } from 'livekit-server-sdk';
import net from 'node:net';

export function isPrivateIPv4(address) {
  if (net.isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function mediaConfig(env = process.env) {
  if (!env.LOCAL_MEDIA_IP) return null;
  if (!isPrivateIPv4(env.LOCAL_MEDIA_IP)) throw new Error('LOCAL_MEDIA_IP muss eine private IPv4-Adresse im LAN sein.');
  if (!env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) throw new Error('LiveKit-Zugangsdaten fehlen.');
  return { ip: env.LOCAL_MEDIA_IP, key: env.LIVEKIT_API_KEY, secret: env.LIVEKIT_API_SECRET };
}

export async function mediaToken(config, { code, session, role, viewerId, name }) {
  const token = new AccessToken(config.key, config.secret, {
    identity: role === 'host' ? 'host' : viewerId, name: name || role, ttl: '5m',
  });
  // The first participant creates the room: host and viewer tokens need the same hints.
  token.roomConfig = new RoomConfiguration({ minPlayoutDelay: PLAYOUT_TARGET_MS, maxPlayoutDelay: PLAYOUT_TARGET_MS });
  token.addGrant({
    room: `sms-${code}-${session}`, roomJoin: true,
    canPublish: role === 'host', canSubscribe: role !== 'host', canPublishData: false,
    ...(role === 'host' ? { canPublishSources: [TrackSource.SCREEN_SHARE] } : {}),
  });
  return token.toJwt();
}
