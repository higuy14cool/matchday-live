const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' }
];

// ---------------------------------------------------------------- game room
// The hosted app keeps the room on a WebSocket server. Here every tab of this
// browser joins the room through a BroadcastChannel, so two windows can share
// the scoreboard and even the camera stream without any server at all.

const rooms = new Map(); // gameId -> Set<GameSocket> (this tab)
const channels = new Map(); // gameId -> BroadcastChannel (every tab)
const peers = new Map(); // gameId -> Set<socket id> heard from other tabs
let socketSeq = 0;

function channelFor(gameId) {
  if (!channels.has(gameId)) {
    const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(`matchday-room-${gameId}`) : null;
    channels.set(gameId, channel);
  }
  return channels.get(gameId);
}

function peersOf(gameId) {
  if (!peers.has(gameId)) peers.set(gameId, new Set());
  return peers.get(gameId);
}

function socketsOf(gameId) {
  if (!rooms.has(gameId)) rooms.set(gameId, new Set());
  return rooms.get(gameId);
}

function post(gameId, payload) {
  const channel = channelFor(gameId);
  if (channel) channel.postMessage(payload);
}

/** Push a fresh game state to this tab's sockets and every other tab. */
export function publishGame(game) {
  if (!game || !game.id) return;
  for (const socket of socketsOf(game.id)) socket.emit('game', { type: 'game', game });
  post(game.id, { kind: 'game', game });
}

export class GameSocket {
  constructor(gameId) {
    this.gameId = gameId;
    this.id = `s${socketSeq++}`;
    this.handlers = new Map();
    this.connected = false;
    this.onAir = false;
    this.onChannel = event => this.receive(event.data);
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
    return () => this.handlers.get(type).delete(fn);
  }

  emit(type, payload) {
    const set = this.handlers.get(type);
    if (set) for (const fn of set) {
      try { fn(payload); } catch (err) { console.error(err); }
    }
  }

  connect() {
    // Only one socket per game in this tab is live at a time.
    for (const other of socketsOf(this.gameId)) {
      if (other !== this) other.close();
    }
    socketsOf(this.gameId).add(this);
    const channel = channelFor(this.gameId);
    if (channel) channel.addEventListener('message', this.onChannel);
    this.connected = true;

    this.emit('status', { connected: true });
    this.emit('hello', { type: 'hello', id: this.id, gameId: this.gameId, viewers: peersOf(this.gameId).size, onAir: false });
    post(this.gameId, { kind: 'here', from: this.id });
  }

  send(message) {
    if (!message || !this.connected) return;
    if (message.type === 'subscribe' || message.type === 'unsubscribe' || message.type === 'ping') return;

    if (message.type === 'broadcast') {
      if (message.on) {
        this.onAir = true;
        this.emit('onair', {
          type: 'onair',
          on: true,
          self: true,
          viewers: peersOf(this.gameId).size,
          viewerIds: [...peersOf(this.gameId)]
        });
        post(this.gameId, { kind: 'onair', from: this.id, on: true });
        this.emit('presence', { type: 'presence', viewers: peersOf(this.gameId).size, onAir: true });
      } else {
        this.onAir = false;
        post(this.gameId, { kind: 'onair', from: this.id, on: false });
        this.emit('presence', { type: 'presence', viewers: peersOf(this.gameId).size, onAir: false });
      }
      return;
    }

    if (message.type === 'signal' && message.to) {
      post(this.gameId, { kind: 'signal', from: this.id, to: message.to, data: message.data });
    }
  }

  receive(msg) {
    if (!msg || !this.connected || msg.from === this.id) return;

    if (msg.kind === 'here') {
      peersOf(this.gameId).add(msg.from);
      post(this.gameId, { kind: 'here-too', from: this.id, to: msg.from });
      this.emit('viewer-joined', { type: 'viewer-joined', viewerId: msg.from });
      this.emit('presence', { type: 'presence', viewers: peersOf(this.gameId).size, onAir: this.onAir });
      return;
    }

    if (msg.kind === 'here-too' && (!msg.to || msg.to === this.id)) {
      peersOf(this.gameId).add(msg.from);
      this.emit('presence', { type: 'presence', viewers: peersOf(this.gameId).size, onAir: this.onAir });
      return;
    }

    if (msg.kind === 'gone') {
      peersOf(this.gameId).delete(msg.from);
      this.emit('presence', { type: 'presence', viewers: peersOf(this.gameId).size, onAir: this.onAir });
      return;
    }

    if (msg.kind === 'game') {
      this.emit('game', { type: 'game', game: msg.game });
      return;
    }

    if (msg.kind === 'onair') {
      // Another tab took the camera: this one steps down or starts watching.
      if (msg.on && this.onAir) {
        this.onAir = false;
        this.emit('onair', { type: 'onair', on: true, viewers: peersOf(this.gameId).size });
      } else {
        this.emit('onair', { type: 'onair', on: Boolean(msg.on), viewers: peersOf(this.gameId).size });
      }
      this.emit('presence', { type: 'presence', viewers: peersOf(this.gameId).size, onAir: Boolean(msg.on) });
      return;
    }

    if (msg.kind === 'signal' && msg.to === this.id) {
      this.emit('signal', { type: 'signal', from: msg.from, data: msg.data });
    }
  }

  close() {
    if (!this.connected) return;
    this.connected = false;
    const channel = channelFor(this.gameId);
    if (channel) channel.removeEventListener('message', this.onChannel);
    socketsOf(this.gameId).delete(this);
    peersOf(this.gameId).delete(this.id);
    if (this.onAir) post(this.gameId, { kind: 'onair', from: this.id, on: false });
    post(this.gameId, { kind: 'gone', from: this.id });
  }
}

function newPeer() {
  return new RTCPeerConnection({ iceServers: ICE_SERVERS });
}

/** Camera owner: offers a peer connection to every viewer. */
export class Broadcaster {
  constructor({ socket, stream, onPeer }) {
    this.socket = socket;
    this.stream = stream;
    this.peers = new Map();
    this.onPeer = onPeer || (() => {});
    this.stopped = false;
  }

  start() {
    this.stopped = false;
    this.socket.send({ type: 'broadcast', on: true });
  }

  handleViewerJoin(viewerId) {
    if (this.stopped) return;
    this.offer(viewerId);
  }

  peer(viewerId) {
    if (this.peers.has(viewerId)) return this.peers.get(viewerId);
    const pc = newPeer();
    for (const track of this.stream.getTracks()) pc.addTrack(track, this.stream);
    pc.onicecandidate = event => {
      if (event.candidate) {
        this.socket.send({ type: 'signal', to: viewerId, data: { kind: 'candidate', candidate: event.candidate } });
      }
    };
    pc.onconnectionstatechange = () => this.onPeer(viewerId, pc.connectionState);
    this.peers.set(viewerId, pc);
    return pc;
  }

  async offer(viewerId) {
    try {
      const pc = this.peer(viewerId);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.socket.send({ type: 'signal', to: viewerId, data: { kind: 'offer', sdp: pc.localDescription } });
    } catch (err) {
      console.warn('Could not offer to viewer', err);
    }
  }

  async handleSignal(from, data) {
    if (!data) return;
    const pc = this.peers.get(from);
    if (!pc) return;
    try {
      if (data.kind === 'answer' && data.sdp) {
        await pc.setRemoteDescription(data.sdp);
        this.flush(pc);
      } else if (data.kind === 'candidate' && data.candidate) {
        await this.addCandidate(pc, data.candidate);
      }
    } catch (err) {
      console.warn('Broadcaster signal error', err);
    }
  }

  async addCandidate(pc, candidate) {
    if (pc.remoteDescription) {
      try { await pc.addIceCandidate(candidate); } catch { /* stale candidate */ }
    } else {
      pc._pending = pc._pending || [];
      pc._pending.push(candidate);
    }
  }

  async flush(pc) {
    const pending = pc._pending || [];
    pc._pending = [];
    for (const candidate of pending) {
      try { await pc.addIceCandidate(candidate); } catch { /* stale candidate */ }
    }
  }

  stop(sendOff = true) {
    this.stopped = true;
    for (const pc of this.peers.values()) pc.close();
    this.peers.clear();
    for (const track of this.stream.getTracks()) track.stop();
    if (sendOff) this.socket.send({ type: 'broadcast', on: false });
  }
}

/** Viewer: answers the broadcaster's offer and plays the remote stream. */
export class Viewer {
  constructor({ socket, video, onState }) {
    this.socket = socket;
    this.video = video;
    this.onState = onState || (() => {});
    this.pc = null;
    this.pending = [];
    this.broadcasterId = null;
    this.generation = 0;
  }

  async handleSignal(from, data) {
    if (!data) return;
    if (data.kind === 'offer' && data.sdp) {
      this.broadcasterId = from;
      await this.acceptOffer(from, data.sdp);
    } else if (data.kind === 'candidate' && data.candidate) {
      if (this.pc && this.pc.remoteDescription) {
        try { await this.pc.addIceCandidate(data.candidate); } catch { /* stale */ }
      } else {
        this.pending.push(data.candidate);
      }
    }
  }

  async acceptOffer(from, sdp) {
    const gen = ++this.generation;
    if (this.pc) {
      try { this.pc.close(); } catch { /* already closed */ }
    }
    const pc = newPeer();
    this.pc = pc;
    this.pending = [];

    pc.ontrack = event => {
      if (gen !== this.generation) return;
      const stream = event.streams[0] || new MediaStream([event.track]);
      this.video.srcObject = stream;
      this.video.play().catch(() => this.onState('blocked'));
      this.onState('playing');
    };
    pc.onicecandidate = event => {
      if (event.candidate) {
        this.socket.send({ type: 'signal', to: from, data: { kind: 'candidate', candidate: event.candidate } });
      }
    };
    pc.onconnectionstatechange = () => {
      if (gen !== this.generation) return;
      if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) this.onState(pc.connectionState);
      if (pc.connectionState === 'connected') this.onState('connected');
    };

    try {
      await pc.setRemoteDescription(sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.socket.send({ type: 'signal', to: from, data: { kind: 'answer', sdp: pc.localDescription } });
      for (const candidate of this.pending) {
        try { await pc.addIceCandidate(candidate); } catch { /* stale */ }
      }
      this.pending = [];
    } catch (err) {
      console.warn('Viewer could not accept stream', err);
      this.onState('failed');
    }
  }

  stop() {
    this.generation++;
    if (this.pc) {
      try { this.pc.close(); } catch { /* already closed */ }
      this.pc = null;
    }
    this.video.srcObject = null;
  }
}

export async function getCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('This browser cannot access a camera. Try Chrome, Edge or Safari over HTTPS.');
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: { ideal: 'environment' } },
      audio: { echoCancellation: true, noiseSuppression: true }
    });
  } catch (err) {
    if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
      throw new Error('Camera and microphone permission was blocked. Allow access in your browser and try again.');
    }
    if (err && err.name === 'NotFoundError') {
      throw new Error('No camera or microphone was found on this device.');
    }
    throw new Error('Could not start the camera. Another app may be using it.');
  }
}
