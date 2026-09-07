// Only loaded for the optional SFU mode; the direct transport stays independent.
export class MediaClient {
  constructor({ credentials, video, track, publishOptions, onStatus = () => {}, onVideo = () => {}, onParticipants = () => {}, loadSDK = () => import('/vendor/livekit.mjs') }) {
    Object.assign(this, { credentials, video, track, publishOptions, onStatus, onVideo, onParticipants, loadSDK });
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
      room = new sdk.Room({ adaptiveStream: false, dynacast: false, disconnectOnPageLeave: true, stopLocalTrackOnUnpublish: false });
      this.room = room;
      const participants = () => { if (current()) this.onParticipants([...room.remoteParticipants.values()]); };
      room.on(sdk.RoomEvent.ParticipantConnected, participants);
      room.on(sdk.RoomEvent.ParticipantDisconnected, participants);
      room.on(sdk.RoomEvent.Reconnecting, () => { if (current()) this.onStatus('reconnecting'); });
      room.on(sdk.RoomEvent.Reconnected, () => { if (current()) this.onStatus('connected'); });
      room.on(sdk.RoomEvent.Disconnected, () => { if (current()) this.retry(generation); });
      room.on(sdk.RoomEvent.TrackSubscribed, (track, publication, participant) => {
        if (!current() || !this.video || participant.identity !== 'host' || track.kind !== 'video') return;
        track.attach(this.video);
        this.remoteTrack = track;
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
        await room.localParticipant.publishTrack(this.track, {
          source: sdk.Track.Source.ScreenShare,
          // One encoding independent of the number of tablets.
          simulcast: false, videoCodec: 'vp8', backupCodec: false,
          ...this.publishOptions,
        });
      }
      if (!current()) { await room.disconnect(false); return; }
      this.onStatus('connected');
      participants();
    } catch {
      if (current()) this.retry(generation);
      else room?.disconnect(false);
    }
  }

  retry(generation) {
    if (!this.active || this.generation !== generation) return;
    ++this.generation;
    const room = this.room;
    this.room = null;
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
    const room = this.room;
    this.room = null;
    room?.disconnect(false);
  }
}
