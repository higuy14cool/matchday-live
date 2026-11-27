import { api, canEdit } from '../api.js';
import { toast, confirmDialog, showFormModal, copyText } from '../ui.js';
import { esc, colorOf, clockState, periodLabel, embedUrl, SPORT_LABEL, eventLabel, OVERLAY_EVENTS } from '../util.js';
import { feedItem, sportPill, statusPill } from '../components.js';
import { GameSocket, Broadcaster, Viewer, getCamera } from '../live.js';
import { openStreamLink } from './forms.js';

const NEXT_PERIOD_LABEL = { soccer: 'Next half', basketball: 'Next quarter' };

function scoreboardHTML(game, home, away, prev) {
  const clock = clockState(game, Date.now());
  const homeBump = prev && game.score.home > prev.home ? ' bump' : '';
  const awayBump = prev && game.score.away > prev.away ? ' bump' : '';
  return `
    <div class="sb-grid">
      <div class="sb-team">
        <span class="sb-crest" style="background:${colorOf(home)}">${esc(home.short || 'HOM')}</span>
        <span class="sb-name">${esc(home.name)}</span>
        <span class="sb-score${homeBump}" data-side-score="home">${game.score.home}</span>
      </div>
      <div class="sb-center">
        <span class="sb-clock${clock.running ? ' running' : ''}" data-sb-clock>${esc(clock.text)}</span>
        <span class="sb-period">${esc(periodLabel(game.sport, game.period))}</span>
        <span class="sb-status">${game.status === 'live' ? '● Live' : game.status === 'final' ? 'Full time' : 'Kick-off soon'}</span>
      </div>
      <div class="sb-team">
        <span class="sb-crest" style="background:${colorOf(away)}">${esc(away.short || 'AWY')}</span>
        <span class="sb-name">${esc(away.name)}</span>
        <span class="sb-score${awayBump}" data-side-score="away">${game.score.away}</span>
      </div>
    </div>`;
}

function overlayHTML(game, home, away) {
  return `
    <div class="ov-team">${esc(home.short || home.name)}<span class="ov-score">${game.score.home}</span></div>
    <div class="ov-mid">${esc(periodLabel(game.sport, game.period))}<b data-ov-clock>${esc(clockState(game, Date.now()).text)}</b></div>
    <div class="ov-team">${esc(away.short || away.name)}<span class="ov-score">${game.score.away}</span></div>`;
}

function controlsHTML(game, home, away) {
  const sideBox = (side, team) => {
    const buttons = game.sport === 'basketball'
      ? `<div class="score-btns">
           <button class="score-btn primary" data-act="event" data-side="${side}" data-type="score" data-points="1">+1</button>
           <button class="score-btn primary" data-act="event" data-side="${side}" data-type="score" data-points="2">+2</button>
           <button class="score-btn primary" data-act="event" data-side="${side}" data-type="score" data-points="3">+3</button>
         </div>
         <div class="score-btns two" style="margin-top:6px">
           <button class="score-btn warn" data-act="event" data-side="${side}" data-type="foul">Foul</button>
           <button class="score-btn" data-act="event" data-side="${side}" data-type="timeout">Timeout</button>
         </div>`
      : `<div class="score-btns two">
           <button class="score-btn primary" data-act="event" data-side="${side}" data-type="goal">⚽ Goal</button>
           <button class="score-btn warn" data-act="event" data-side="${side}" data-type="own_goal">Own goal</button>
         </div>
         <div class="score-btns two" style="margin-top:6px">
           <button class="score-btn" data-act="event" data-side="${side}" data-type="yellow">🟨 Yellow</button>
           <button class="score-btn danger" data-act="event" data-side="${side}" data-type="red">🟥 Red</button>
         </div>`;
    return `<div class="ctrl-box"><div class="ttl">${esc(team.name)}</div>${buttons}</div>`;
  };

  return `
    <div class="ctrl-groups">${sideBox('home', home)}${sideBox('away', away)}</div>
    <div class="clock-row">
      <button class="btn btn-sm ${game.clock.running ? 'btn-ghost' : 'btn-primary'}" data-act="clock-toggle">${game.clock.running ? '⏸ Pause' : '▶ Start clock'}</button>
      <button class="btn btn-sm btn-ghost" data-act="clock-next">${NEXT_PERIOD_LABEL[game.sport] || 'Next period'}</button>
      <button class="btn btn-sm btn-ghost" data-act="clock-reset">Reset clock</button>
      <button class="btn btn-sm btn-ghost" data-act="score-edit">Set score</button>
      ${game.stage && game.stage !== 'group' && game.status === 'scheduled'
        ? '<button class="btn btn-sm btn-ghost" data-act="edit-teams">Change teams</button>' : ''}
      <button class="btn btn-sm btn-ghost" data-act="undo">↶ Undo</button>
      <button class="btn btn-sm btn-danger" data-act="end-game">End game</button>
    </div>`;
}

const RAPID_ACTIONS = [
  { type: 'var', label: 'VAR', title: 'VAR review' },
  { type: 'yellow', label: '🟨 Yellow', title: 'Yellow card' },
  { type: 'red', label: '🟥 Red', title: 'Red card' },
  { type: 'yellow_red', label: '🟨🟥 → Red', title: 'Second yellow → red' },
  { type: 'goal', label: '＋ Goal', title: 'Goal' },
  { type: 'minus_goal', label: '－ Goal', title: 'Remove a goal' }
];

function rapidBarHTML() {
  return RAPID_ACTIONS.map(a => `<button type="button" class="rapid-btn ${a.type}" data-rapid="${a.type}" title="${esc(a.title)}">${a.label}</button>`).join('');
}

function stageHTML() {
  return `
    <div class="stage" id="stage">
      <video id="stage-video" playsinline autoplay hidden></video>
      <iframe id="stage-frame" class="stage-embed" title="Live video" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen hidden></iframe>
      <div class="stage-placeholder" id="stage-placeholder"></div>
      <div class="stage-top" id="stage-top">
        <span class="stage-badge hidden" id="stage-live-badge"><span style="color:var(--red)">●</span> LIVE</span>
        <span class="stage-badge hidden" id="stage-viewers"></span>
      </div>
      <div class="stage-overlay hidden" id="stage-overlay"></div>
      <div class="stage-events" id="stage-events" hidden></div>
      <div class="stage-actbar hidden" id="stage-actbar"></div>
    </div>`;
}

export async function renderGame(app, id) {
  let data = await api.get(`/games/${encodeURIComponent(id)}`);
  let game = data.game;
  let syncedAt = Date.now();
  let owner = canEdit();
  let prevScore = { ...game.score };

  let socket = null;
  let broadcaster = null;
  let broadcasterActive = false;
  let viewer = null;
  let videoReady = false;
  let remoteOnAir = false;
  let viewers = 0;
  let stageState = 'idle';
  let alive = true;
  let ticker = null;
  let bumpTimer = null;

  app.innerHTML = `
    <a class="backlink" id="back-link" href="#/t/${encodeURIComponent(game.tournamentId)}">← Tournament</a>
    <div class="page-head">
      <div>
        <h1 style="font-size:clamp(20px,2.6vw,28px)">${esc(data.home.name)} <span class="muted" style="font-weight:600">vs</span> ${esc(data.away.name)}</h1>
        <div class="page-sub" id="head-meta"></div>
      </div>
      <div class="head-actions">
        <button class="btn btn-sm btn-ghost" data-act="copy">🔗 Share</button>
        <a class="btn btn-sm btn-ghost" href="#/g/${encodeURIComponent(game.id)}/board">⛶ Big scoreboard</a>
      </div>
    </div>
    <div class="tour-layout">
      <div>
        <section class="card scoreboard" id="scoreboard">${scoreboardHTML(game, data.home, data.away)}</section>
        <div id="control-host"></div>
        <section class="panel" style="margin-top:16px">
          <div class="panel-head">
            <span class="panel-title">Game feed</span>
            <span class="tiny muted" id="feed-count"></span>
          </div>
          <div class="feed" id="feed"></div>
        </section>
      </div>
      <div>
        <section class="panel">
          <div class="panel-head">
            <span class="panel-title">Live video</span>
            <span class="tiny muted" id="stream-mode"></span>
          </div>
          <div class="panel-body">
            ${stageHTML()}
            <div class="stage-actions">
              <button class="btn btn-sm btn-primary hidden" data-act="go-live" id="go-live-btn">● Go live</button>
              <button class="btn btn-sm btn-ghost hidden" data-act="stop-live" id="stop-live-btn">Stop stream</button>
              <button class="btn btn-sm btn-ghost hidden" data-act="embed" id="embed-btn">Embed a link</button>
              <span class="tiny muted" id="live-hint"></span>
            </div>
          </div>
        </section>
        <section class="panel">
          <div class="panel-head"><span class="panel-title">Match info</span></div>
          <div class="panel-body" id="match-info"></div>
        </section>
      </div>
    </div>`;

  const $ = sel => app.querySelector(sel);
  const scoreEl = $('#scoreboard');
  const feedEl = $('#feed');
  const controlHost = $('#control-host');
  const videoEl = $('#stage-video');
  const frameEl = $('#stage-frame');
  const placeholderEl = $('#stage-placeholder');
  const overlayEl = $('#stage-overlay');
  const liveBadge = $('#stage-live-badge');
  const viewersEl = $('#stage-viewers');
  const stageEl = $('#stage');
  stageEl.addEventListener('click', e => {
    const btn = e.target.closest('[data-rapid]');
    if (!btn || !owner) return;
    openRapidAction(btn.dataset.rapid);
  });

  // ------------------------------------------------------------- rendering
  function renderHead() {
    const meta = [];
    meta.push(sportPill(game.sport));
    meta.push(statusPill(game));
    if (game.round) meta.push(`<span>${esc(game.round)}</span>`);
    if (game.venue) meta.push(`<span>📍 ${esc(game.venue)}</span>`);
    meta.push(`<span>${esc(new Date(game.scheduledAt).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}</span>`);
    if (owner) meta.push('<span class="pill" style="color:var(--lime);border-color:rgba(154,230,75,.3)">Organizer</span>');
    $('#head-meta').innerHTML = meta.join('');
    $('#back-link').setAttribute('href', `#/t/${encodeURIComponent(game.tournamentId)}`);
  }

  function renderScoreboard(withBump = true) {
    const ticket = withBump ? prevScore : null;
    scoreEl.innerHTML = scoreboardHTML(game, data.home, data.away, ticket);
    overlayEl.innerHTML = overlayHTML(game, data.home, data.away);
    clearTimeout(bumpTimer);
    if (ticket) bumpTimer = setTimeout(() => scoreEl.querySelectorAll('.bump').forEach(el => el.classList.remove('bump')), 400);
  }

  function renderFeed() {
    const events = (game.events || []).slice().reverse();
    $('#feed-count').textContent = events.length ? `${events.length} events` : '';
    feedEl.innerHTML = events.length
      ? events.map(ev => feedItem({ ...ev, periodLengthMs: game.periodLengthMs }, data.home, data.away, game.sport)).join('')
      : '<div class="empty" style="border:0"><span class="big">📋</span><strong>No events yet</strong><span class="tiny">Goals, points and cards show up here live.</span></div>';
  }

  function renderControls() {
    const final = game.status === 'final';
    $('#control-host').innerHTML = owner
      ? `${final ? `<div class="owner-note" style="border-color:rgba(255,159,69,.35)">This game is finished. Reopen it to make changes. <button class="btn btn-sm btn-ghost" data-act="reopen">Reopen game</button></div>` : ''}
         <div class="controls">${controlsHTML(game, data.home, data.away)}</div>`
      : `<div class="owner-note">You are watching this game. Only the organizer can change the score or start a stream.<br><span class="tiny">Scores update live in this tab.</span></div>`;
  }

  function renderStage() {
    if (!alive) return;
    const rawEmbed = game.streamUrl ? embedUrl(game.streamUrl) : '';
    const hasEmbed = Boolean(rawEmbed) && !broadcasterActive && !remoteOnAir;
    const showVideo = !hasEmbed && (broadcasterActive || remoteOnAir);
    stageState = hasEmbed ? 'embed' : broadcasterActive ? 'broadcast' : remoteOnAir ? 'remote' : 'idle';

    frameEl.hidden = !hasEmbed;
    if (hasEmbed && frameEl.dataset.src !== rawEmbed) {
      frameEl.dataset.src = rawEmbed;
      frameEl.src = rawEmbed;
    }
    videoEl.hidden = !showVideo;
    videoEl.controls = showVideo && !broadcasterActive;
    overlayEl.hidden = !showVideo || (remoteOnAir && !videoReady);
    liveBadge.classList.toggle('hidden', !showVideo);
    viewersEl.classList.toggle('hidden', !showVideo);

    if (showVideo && (broadcasterActive || videoReady)) {
      placeholderEl.hidden = true;
    } else {
      placeholderEl.hidden = false;
      const canGoLive = owner && !rawEmbed;
      placeholderEl.innerHTML = showVideo
        ? '<span class="big">📡</span><strong>Connecting to the broadcast…</strong><span class="tiny">The video starts in a moment. Tap the player if it stays black.</span>'
        : rawEmbed
          ? '<span class="big">📺</span><strong>Embedded stream</strong><span class="tiny">The organizer linked a video for this game.</span>'
          : `<span class="big">🎥</span><strong>No video yet</strong><span class="tiny">${canGoLive ? 'Press “Go live” to broadcast from this device with the scoreboard on screen.' : 'The organizer has not started the video for this game.'}</span>`;
    }

    viewersEl.textContent = showVideo ? `${viewers} watching` : '';
    $('#stream-mode').textContent = broadcasterActive ? 'You are live' : remoteOnAir ? 'On air' : hasEmbed ? 'Embedded' : '';
    $('#go-live-btn').classList.toggle('hidden', !owner || broadcasterActive);
    const embedBtn = $('#embed-btn');
    embedBtn.classList.toggle('hidden', !owner || broadcasterActive);
    embedBtn.textContent = rawEmbed ? 'Change embed link' : 'Embed a link';
    $('#stop-live-btn').classList.toggle('hidden', !broadcasterActive);
    $('#live-hint').textContent = broadcasterActive
      ? 'Keep this tab open while you broadcast.'
      : owner && !rawEmbed ? 'Phone camera works over HTTPS or on localhost.'
      : '';

    const bar = $('#stage-actbar');
    const showBar = owner && game.status !== 'final';
    bar.classList.toggle('hidden', !showBar);
    bar.innerHTML = showBar ? rapidBarHTML() : '';
    renderStageEvents();
  }

  function renderInfo() {
    if (!alive) return;
    $('#match-info').innerHTML = `
      <div class="stack" style="gap:10px;font-size:13.5px">
        <div class="spread"><span class="muted">Tournament</span><a class="link" href="#/t/${encodeURIComponent(game.tournamentId)}">${esc(data.tournament.name)}</a></div>
        <div class="spread"><span class="muted">Sport</span><span>${esc(SPORT_LABEL[game.sport] || game.sport)}</span></div>
        <div class="spread"><span class="muted">Period lengths</span><span class="mono">${game.sport === 'soccer' ? '45 min halves' : '10 min quarters'}</span></div>
        ${game.venue ? `<div class="spread"><span class="muted">Venue</span><span>${esc(game.venue)}</span></div>` : ''}
        <div class="spread"><span class="muted">Updates</span><span>Live${socket && socket.connected ? ' · connected' : ''}</span></div>
      </div>`;
  }

  let lastShownEventId = null;

  /** Left corner of the video: the referee calls and score changes everyone can see. */
  function renderStageEvents() {
    const el = $('#stage-events');
    if (!el) return;
    const seen = (game.events || []).filter(ev => OVERLAY_EVENTS.has(ev.type)).slice(-3).reverse();
    const visible = seen.length > 0 && stageState !== 'embed' && game.status !== 'scheduled';
    el.hidden = !visible;
    if (!visible) {
      el.innerHTML = '';
      return;
    }
    const newestId = seen[0].id;
    el.innerHTML = seen
      .map(ev => {
        const info = eventLabel(ev, data.home, data.away, game.sport);
        return `<div class="stage-ev${ev.id === newestId && newestId !== lastShownEventId ? ' pop' : ''}">
          <span class="sev-icon">${info.icon}</span><span class="sev-text">${info.html}</span>
        </div>`;
      })
      .join('');
    lastShownEventId = newestId;
  }

  /** Admin-only referee buttons: each one asks who it was for, then shows on the viewer's video. */
  function openRapidAction(type) {
    if (!owner) return;
    if (type === 'var') {
      showFormModal({
        title: 'VAR review',
        submitLabel: 'Show on video',
        bodyHTML: `
          <label class="field"><span>Team</span>${teamSelectHTML()}</label>
          <label class="field"><span>What was reviewed?</span>
            <textarea class="input" name="note" rows="3" maxlength="160" required placeholder="e.g. Possible offside before the goal"></textarea>
          </label>`,
        onSubmit: async fields => {
          const note = (fields.note || '').trim();
          if (!note) throw new Error('Describe what was reviewed');
          await sendRapid({ side: fields.side, type, note });
        }
      });
      return;
    }

    const cards = { yellow: 'yellow card', red: 'red card', yellow_red: 'second yellow → red' };
    const isCard = Boolean(cards[type]);
    const title = type === 'goal' ? 'Who scored?' : type === 'minus_goal' ? 'Which goal should be removed?' : `Who gets the ${cards[type]}?`;
    showFormModal({
      title,
      submitLabel: 'Confirm',
      bodyHTML: `
        <label class="field"><span>Team</span>${teamSelectHTML()}</label>
        <label class="field"><span>Player${isCard ? '' : ' <span class="tiny muted">(optional)</span>'}</span>
          <input class="input" name="player" maxlength="40" ${isCard ? 'required' : ''} placeholder="e.g. J. Smith" autocomplete="off" />
        </label>`,
      onSubmit: async fields => {
        const player = (fields.player || '').trim();
        if (isCard && !player) throw new Error('Name the player the card is for');
        await sendRapid({ side: fields.side, type, player: player || undefined });
      }
    });
  }

  function teamSelectHTML() {
    return `<select class="input" name="side">
      <option value="home">${esc(data.home.name)}</option>
      <option value="away">${esc(data.away.name)}</option>
    </select>`;
  }

  async function sendRapid(body) {
    const res = await mutate(`/games/${encodeURIComponent(game.id)}/events`, body);
    if (!res) return false; // keep the dialog open so the admin can retry
    if (res.game) toast(body.type === 'goal' ? 'Goal added' : body.type === 'minus_goal' ? 'Goal removed' : 'Shown to viewers');
    return true;
  }

  function apply(nextGame, fromSocket = false) {
    if (!nextGame || nextGame.id !== game.id) return;
    prevScore = { ...game.score };
    game = nextGame;
    syncedAt = Date.now();
    if (game.status === 'final' && broadcasterActive) stopBroadcast(true);
    renderHead();
    renderScoreboard(true);
    renderFeed();
    renderControls();
    renderStage();
    renderInfo();
  }

  function tickClock() {
    if (!alive) return;
    const clock = clockState(game, syncedAt);
    app.querySelectorAll('[data-sb-clock], [data-ov-clock]').forEach(el => {
      el.textContent = clock.text;
      el.classList.toggle('running', clock.running);
    });
  }

  // -------------------------------------------------------------- requests
  async function mutate(path, body, method = 'post') {
    try {
      const res = method === 'patch'
        ? await api.patch(path, body)
        : await api.post(path, body);
      if (res && res.game) apply(res.game);
      return res;
    } catch (err) {
      toast(err.message, 'error');
      return null;
    }
  }

  function sendEvent(side, type, points) {
    return mutate(`/games/${encodeURIComponent(game.id)}/events`, { side, type, points: points ? Number(points) : undefined });
  }

  // ------------------------------------------------------------- streaming
  async function startBroadcast() {
    const btn = $('#go-live-btn');
    btn.disabled = true;
    btn.textContent = 'Starting…';
    try {
      const stream = await getCamera();
      if (!alive) {
        stream.getTracks().forEach(t => t.stop());
        return;
      }
      broadcaster = new Broadcaster({ socket, stream, onPeer: () => {} });
      broadcasterActive = true;
      broadcaster.start();
      videoEl.srcObject = stream;
      videoEl.muted = true;
      videoEl.play().catch(() => {});
      renderStage();
      toast('You are live for everyone watching this game');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
      if (btn) btn.textContent = '● Go live';
    }
  }

  function stopBroadcast(sendOff = false) {
    if (broadcaster) broadcaster.stop(sendOff);
    broadcaster = null;
    broadcasterActive = false;
    videoReady = false;
    videoEl.srcObject = null;
    renderStage();
  }

  function ensureViewer() {
    if (!viewer) {
      viewer = new Viewer({
        socket,
        video: videoEl,
        onState: state => {
          if (state === 'connected' || state === 'playing') {
            videoReady = true;
            renderStage();
          } else if (state === 'failed' || state === 'closed') {
            if (videoReady) toast('The live video disconnected', 'error');
            videoReady = false;
            renderStage();
          } else if (state === 'blocked') {
            toast('Tap the video once to start sound', 'error');
          }
        }
      });
      videoEl.muted = false;
    }
    return viewer;
  }

  // -------------------------------------------------------------- handlers
  socket = new GameSocket(game.id);
  socket.on('status', () => renderInfo());
  socket.on('hello', msg => {
    viewers = msg.viewers;
    if (msg.onAir) remoteOnAir = true;
    renderStage();
    renderInfo();
  });
  socket.on('presence', msg => {
    viewers = msg.viewers;
    const wasOn = remoteOnAir;
    remoteOnAir = Boolean(msg.onAir) && !broadcasterActive;
    if (!remoteOnAir && wasOn && !broadcasterActive && viewer) {
      viewer.stop();
      viewer = null;
      videoEl.hidden = true;
    }
    renderStage();
  });
  socket.on('game', msg => apply(msg.game, true));
  socket.on('onair', msg => {
    if (msg.self) {
      remoteOnAir = false;
      broadcasterActive = true;
      for (const viewerId of msg.viewerIds || []) broadcaster && broadcaster.handleViewerJoin(viewerId);
    } else {
      if (msg.on) {
        remoteOnAir = !broadcasterActive;
        if (broadcasterActive) {
          // Someone else took over the broadcast: step down quietly.
          stopBroadcast(false);
          remoteOnAir = true;
        }
        ensureViewer();
      } else {
        remoteOnAir = false;
        if (viewer) {
          viewer.stop();
          viewer = null;
        }
        videoEl.hidden = true;
      }
    }
    renderStage();
  });
  socket.on('viewer-joined', msg => {
    if (broadcaster) broadcaster.handleViewerJoin(msg.viewerId);
  });
  socket.on('signal', msg => {
    if (broadcaster) broadcaster.handleSignal(msg.from, msg.data);
    else if (msg.data && msg.data.kind === 'offer') ensureViewer().handleSignal(msg.from, msg.data);
    else if (viewer) viewer.handleSignal(msg.from, msg.data);
  });
  socket.on('error', msg => {
    if (msg.message) toast(msg.message, 'error');
  });
  socket.connect();

  // ---------------------------------------------------------------- clicks
  const onClick = async e => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    if (act === 'copy') return copyText(location.href, 'Game link copied');
    if (act === 'event') return sendEvent(el.dataset.side, el.dataset.type, el.dataset.points);
    if (act === 'clock-toggle') return mutate(`/games/${encodeURIComponent(game.id)}/clock`, { action: game.clock.running ? 'pause' : 'start' });
    if (act === 'clock-next') return mutate(`/games/${encodeURIComponent(game.id)}/clock`, { action: 'next' });
    if (act === 'clock-reset') {
      const ok = await confirmDialog({ title: 'Reset the clock', message: 'Set the clock back to 0:00 for this period?', confirmLabel: 'Reset' });
      if (!ok) return;
      return mutate(`/games/${encodeURIComponent(game.id)}/clock`, { action: 'reset' });
    }
    if (act === 'undo') return mutate(`/games/${encodeURIComponent(game.id)}/undo`, {});
    if (act === 'score-edit') {
      return showFormModal({
        title: 'Set the score',
        submitLabel: 'Save score',
        bodyHTML: `<div class="form-row">
          <label class="field"><span class="label">${esc(data.home.name)}</span><input class="input" type="number" min="0" max="999" name="home" value="${game.score.home}"></label>
          <label class="field"><span class="label">${esc(data.away.name)}</span><input class="input" type="number" min="0" max="999" name="away" value="${game.score.away}"></label>
        </div>
        <label class="ctrl-box" style="display:flex;align-items:center;gap:9px;padding:12px;cursor:pointer">
          <input type="checkbox" name="final" value="yes" ${game.status === 'final' ? 'checked' : ''}>
          <span>This is the final score — mark the game finished</span>
        </label>`,
        onSubmit: async fields => {
          const final = fields.final === 'yes';
          const res = await api.post(`/games/${encodeURIComponent(game.id)}/score`, {
            home: Number(fields.home),
            away: Number(fields.away),
            final
          });
          if (res && res.game) apply(res.game);
          toast(final ? 'Final score saved' : 'Score saved');
        }
      });
    }
    if (act === 'edit-teams') {
      let full;
      try {
        full = await api.get(`/tournaments/${encodeURIComponent(game.tournamentId)}`);
      } catch (err) {
        return toast(err.message, 'error');
      }
      const options = selected => full.teams
        .map(t => `<option value="${esc(t.id)}"${t.id === selected ? ' selected' : ''}>${esc(t.name)}</option>`)
        .join('');
      return showFormModal({
        title: 'Who plays this game?',
        submitLabel: 'Save teams',
        bodyHTML: `<div class="form-row">
          <label class="field"><span class="label">Home</span><select class="select" name="home">${options(game.homeTeamId)}</select></label>
          <label class="field"><span class="label">Away</span><select class="select" name="away">${options(game.awayTeamId)}</select></label>
        </div>
        <p class="hint">The winner still moves on to the next round; the loser drops to the third-place match when the tournament has one.</p>`,
        onSubmit: async fields => {
          const res = await api.patch(`/games/${encodeURIComponent(game.id)}`, {
            homeTeamId: fields.home,
            awayTeamId: fields.away
          });
          if (res && res.home) data.home = res.home;
          if (res && res.away) data.away = res.away;
          if (res && res.game) apply(res.game);
          renderScoreboard(false);
          toast('Matchup updated');
        }
      });
    }
    if (act === 'end-game') {
      const ok = await confirmDialog({ title: 'End this game', message: 'Mark the game as finished? The score is locked until you reopen it.', confirmLabel: 'End game' });
      if (!ok) return;
      return mutate(`/games/${encodeURIComponent(game.id)}`, { status: 'final' }, 'patch');
    }
    if (act === 'reopen') return mutate(`/games/${encodeURIComponent(game.id)}`, { status: 'live' }, 'patch');
    if (act === 'go-live') return startBroadcast();
    if (act === 'stop-live') {
      const ok = await confirmDialog({ title: 'Stop the broadcast', message: 'Viewers will see the scoreboard without video.', confirmLabel: 'Stop stream' });
      if (ok) {
        stopBroadcast(true);
        toast('Broadcast stopped');
      }
      return;
    }
    if (act === 'embed') return openStreamLink(game, async () => {
      const fresh = await api.get(`/games/${encodeURIComponent(game.id)}`);
      apply(fresh.game);
    });
  };
  app.addEventListener('click', onClick);

  renderHead();
  renderScoreboard(false);
  renderFeed();
  renderControls();
  renderStage();
  renderInfo();
  ticker = setInterval(tickClock, 250);

  return () => {
    alive = false;
    clearInterval(ticker);
    clearTimeout(bumpTimer);
    app.removeEventListener('click', onClick);
    if (broadcaster) broadcaster.stop(true);
    if (viewer) viewer.stop();
    if (socket) socket.close();
  };
}
