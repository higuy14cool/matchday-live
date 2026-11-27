const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' }
];

/** WebSocket client for one game room, with automatic reconnect. */
export class GameSocket {
  constructor(gameId) {
    this.gameId = gameId;
    this.handlers = new Map();
    this.ws = null;
    this.closed = false;
    this.retry = 0;
    this.queue = [];
    this.connected = false;
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
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let ws;
    try {
      ws = new WebSocket(`${proto}//${location.host}/ws`);
    } catch {
      this.emit('status', { connected: false });
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.retry = 0;
      this.connected = true;
      ws.send(JSON.stringify({ type: 'subscribe', gameId: this.gameId }));
      const queued = this.queue.splice(0);
      for (const msg of queued) ws.send(JSON.stringify(msg));
      this.emit('status', { connected: true });
    };

    ws.onmessage = event => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg && typeof msg.type === 'string') this.emit(msg.type, msg);
    };

    ws.onclose = () => {
      this.connected = false;
      this.emit('status', { connected: false });
      if (this.closed) return;
      const delay = Math.min(8000, 500 * 2 ** this.retry);
      this.retry = Math.min(this.retry + 1, 5);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => {};
  }

  send(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      this.queue.push(message);
      if (this.queue.length > 40) this.queue.shift();
    }
  }

  close() {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    if (this.ws) this.ws.close();
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
