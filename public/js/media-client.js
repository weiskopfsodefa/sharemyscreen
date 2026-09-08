import { mediaLayers, applyPlayoutTarget } from './media-options.js';
import { receiverStats } from './media-stats.js';

// Only loaded for the optional SFU mode; the direct transport stays independent.
export class MediaClient {
  constructor({ credentials, video, track, publishOptions, streamMode = 'motion', onStatus = () => {}, onVideo = () => {}, onParticipants = () => {}, loadSDK = () => import('/vendor/livekit.mjs') }) {
    Object.assign(this, { credentials, video, track, publishOptions, streamMode, onStatus, onVideo, onParticipants, loadSDK });
    this.active = false;
    this.generation = 0;
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.connect();
  }

  async connect() {
    const generation = ++this.generation;
    const current = () => this.active && this.generation === generation;
    let room;
    try {
      this.onStatus('connecting');
      const [sdk, credentials] = await Promise.all([this.loadSDK(), this.credentials()]);
      if (!current()) return;
      room = new sdk.Room({ adaptiveStream: { pixelDensity: 'screen' }, dynacast: true, disconnectOnPageLeave: true, stopLocalTrackOnUnpublish: false });
      this.room = room;
      const participants = () => { if (current()) this.onParticipants([...room.remoteParticipants.values()]); };
      room.on(sdk.RoomEvent.ParticipantConnected, participants);
      room.on(sdk.RoomEvent.ParticipantDisconnected, participants);
      room.on(sdk.RoomEvent.Reconnecting, () => { if (current()) this.onStatus('reconnecting'); });
      room.on(sdk.RoomEvent.Reconnected, () => {
        if (!current()) return;
        applyPlayoutTarget(this.remoteTrack?.receiver);
        this.onStatus('connected');
      });
      room.on(sdk.RoomEvent.Disconnected, () => { if (current()) this.retry(generation); });
      room.on(sdk.RoomEvent.TrackSubscribed, (track, publication, participant) => {
        if (!current() || !this.video || participant.identity !== 'host' || track.kind !== 'video') return;
        track.attach(this.video);
        this.remoteTrack = track;
        applyPlayoutTarget(track.receiver);
        this.onVideo(true);
      });
      room.on(sdk.RoomEvent.TrackUnsubscribed, track => {
        if (!current() || track !== this.remoteTrack) return;
        track.detach(this.video);
        this.remoteTrack = null;
        this.onVideo(false);
      });
      await room.connect(credentials.url, credentials.token, { autoSubscribe: !this.track, websocketTimeout: 10000, peerConnectionTimeout: 15000, rtcConfig: { iceServers: [] } });
      if (!current()) { await room.disconnect(false); return; }
      if (this.track) {
        const publication = await room.localParticipant.publishTrack(this.track, {
          source: sdk.Track.Source.ScreenShare,
          // At most three encodings; Dynacast pauses unused layers.
          simulcast: true, videoCodec: 'vp8', backupCodec: false,
          ...this.publishOptions,
          screenShareSimulcastLayers: mediaLayers(this.track.getSettings(), this.publishOptions?.screenShareEncoding, this.streamMode)
            .map(layer => new sdk.VideoPreset(layer.width, layer.height, layer.maxBitrate, layer.maxFramerate)),
        });
        if (!current()) { await room.disconnect(false); return; }
        this.localTrack = publication?.track;
      }
      if (!current()) { await room.disconnect(false); return; }
      this.onStatus('connected');
      participants();
    } catch {
      if (current()) this.retry(generation);
      else room?.disconnect(false);
    }
  }

  async readStats() {
    const track = this.remoteTrack;
    const generation = this.generation;
    if (!this.active || !track) return null;
    const report = await track.getRTCStatsReport();
    if (!this.active || generation !== this.generation || track !== this.remoteTrack) return null;
    const sample = receiverStats(report, this.statsTrack === track ? this.statsSample : null);
    this.statsTrack = track;
    this.statsSample = sample;
    return sample?.stats ?? null;
  }

  retry(generation) {
    if (!this.active || this.generation !== generation) return;
    ++this.generation;
    const room = this.room;
    this.room = null;
    this.localTrack = null;
    room?.disconnect(false);
    this.remoteTrack?.detach(this.video);
    this.remoteTrack = null;
    if (this.video) this.onVideo(false);
    this.onParticipants([]);
    this.onStatus('retrying');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { if (this.active) this.connect(); }, 3000);
  }

  stop() {
    this.active = false;
    ++this.generation;
    clearTimeout(this.timer);
    this.remoteTrack?.detach(this.video);
    this.remoteTrack = null;
    this.statsSample = null;
    this.statsTrack = null;
    const room = this.room;
    this.room = null;
    this.localTrack = null;
    room?.disconnect(false);
  }
}
