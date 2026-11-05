(function () {
  // Opened from the QR code on a phone: act only as a camera sender.
  const senderTarget = new URLSearchParams(location.search).get('cam');
  if (senderTarget) {
    runSender(senderTarget);
    return;
  }

  const stage = document.getElementById('stage');
  const stageEmpty = document.getElementById('stageEmpty');
  const video = document.getElementById('webcamFeed');
  const img = document.getElementById('ipcamFeed');
  const canvas = document.getElementById('overlay');
  const ctx = canvas.getContext('2d');
  const modelStatus = document.getElementById('modelStatus');
  const toggleDetectionBtn = document.getElementById('toggleDetection');
  const addZoneBtn = document.getElementById('addZone');
  const clearZonesBtn = document.getElementById('clearZones');
  const zoneHint = document.getElementById('zoneHint');
  const tableList = document.getElementById('tableList');
  const tableCountEl = document.getElementById('tableCount');
  const freeCountEl = document.getElementById('freeCount');
  const busyCountEl = document.getElementById('busyCount');
  const ipcamUrlWrap = document.getElementById('ipcamUrlWrap');
  const ipcamUrlInput = document.getElementById('ipcamUrl');
  const connectIpcamBtn = document.getElementById('connectIpcam');
  const sourceRadios = document.querySelectorAll('input[name="source"]');
  const phonePanel = document.getElementById('phonePanel');
  const phoneStatus = document.getElementById('phoneStatus');
  const qrBox = document.getElementById('qrcode');
  const phoneLink = document.getElementById('phoneLink');
  const copyPhoneLinkBtn = document.getElementById('copyPhoneLink');
  const startScreenBtn = document.getElementById('startScreenBtn');
  const groupChipsEl = document.getElementById('groupChips');
  const newGroupInput = document.getElementById('newGroupInput');
  const addGroupBtn = document.getElementById('addGroupBtn');
  const groupListEl = document.getElementById('groupList');
  const liveStatusEl = document.getElementById('liveStatus');
  const pubFreeEl = document.getElementById('pubFree');
  const pubTotalEl = document.getElementById('pubTotal');
  const pubLabelEl = document.getElementById('pubLabel');
  const pubBarEl = document.getElementById('pubBar');
  const pubUpdatedEl = document.getElementById('pubUpdated');
  const pubGroupsEl = document.getElementById('pubGroups');
  const pubOpenEl = document.getElementById('pubOpen');
  const adminBtn = document.getElementById('adminBtn');
  const loginDialog = document.getElementById('loginDialog');
  const loginForm = document.getElementById('loginForm');
  const loginUser = document.getElementById('loginUser');
  const loginPass = document.getElementById('loginPass');
  const loginError = document.getElementById('loginError');
  const loginCancel = document.getElementById('loginCancel');

  // Simple demo login for a class project: credentials live in the client, so this only hides the UI.
  const ADMIN_USER = 'admin';
  const ADMIN_PASS = '12345';
  const ADMIN_KEY = 'spaceiq.admin';

  const STORAGE_KEY = 'spaceiq.tables.v1';

  // Occupancy rules: a table stays occupied for GRACE_MS after the person leaves, and stays
  // "away" (unavailable) while personal objects remain on it, up to AWAY_MAX_MS.
  // ?grace=<minutes> in the URL overrides the grace period (handy for demos and tests).
  // ?confirm=<seconds> overrides the confirmation time (0 disables it).
  const urlParams = new URLSearchParams(location.search);
  // The grace period (minutes) is adjustable in the admin panel; ?grace= in the URL still overrides it.
  const GRACE_KEY = 'hubvision.graceMinutes';
  const graceParam = parseFloat(urlParams.get('grace'));
  let graceMinutes = loadGraceMinutes();
  let GRACE_MS = graceMinutes * 60 * 1000;

  function loadGraceMinutes() {
    if (Number.isFinite(graceParam) && graceParam >= 0) return graceParam;
    try {
      const saved = parseFloat(localStorage.getItem(GRACE_KEY));
      return Number.isFinite(saved) && saved >= 0 && saved <= 30 ? saved : 8;
    } catch {
      return 8;
    }
  }
  const confirmParam = parseFloat(urlParams.get('confirm'));
  const CONFIRM_MS = (Number.isFinite(confirmParam) && confirmParam >= 0 ? confirmParam : 3) * 1000;
  const AWAY_MAX_MS = 30 * 60 * 1000;
  const OBJECT_CLASSES = ['laptop', 'backpack', 'handbag', 'suitcase', 'book', 'cell phone'];
  const OBJECT_MIN_SCORE = 0.4;
  const OBJECT_HOLD_MS = 20 * 1000; // bridges frames where an object is momentarily missed

  let model = null;
  let activeMedia = null; // 'video' | 'img' | null
  let detecting = false;
  let zones = loadZones();
  let latestPersons = []; // fractional boxes, for on-screen debug only
  let latestMaxScore = 0;
  // Minimum confidence for a "person" to count; the admin tunes it with the sensitivity slider.
  const SENSITIVITY_KEY = 'hubvision.personMinScore';
  let personMinScore = loadSensitivity();
  let isDrawingZone = false;
  let dragStart = null;
  let dragCurrent = null;
  let zoneCounter = zones.reduce((max, z) => Math.max(max, z.n || 0), 0);
  let webcamStream = null;
  let phonePeer = null;
  let phoneCall = null;

  // Live sharing: the admin browser hosts a fixed PeerJS id and pushes table states to public viewers.
  const LIVE_PEER_ID = 'hubvision-live-7f3a9c2e';

  // Relay: the direct browser-to-browser link (above) fails on some browsers or networks (VPN, WebRTC
  // protection), so the admin also posts the seat states to a public message service (ntfy.sh, no account)
  // on a secret channel, and the public view listens there. Only states are sent, never video or images.
  const RELAY_TOPIC = 'hubvision-cf2aadb520892279f6a4';
  const RELAY_URL = 'https://ntfy.sh/' + RELAY_TOPIC;
  const RELAY_MIN_GAP_MS = 3000; // at most one post every 3 s: changes are merged
  const RELAY_HEARTBEAT_MS = 10 * 60 * 1000; // re-post now and then so the latest state stays available
  const RELAY_MAX_AGE_MS = 30 * 60 * 1000; // a state older than this says nothing about now
  const RELAY_FRESH_S = 12 * 60; // quiet for longer than a heartbeat plus a margin: no longer "live"
  const STATUS_TO_CODE = { free: 'f', busy: 'b', grace: 'g', away: 'a' };
  const CODE_TO_STATUS = { f: 'free', b: 'busy', g: 'grace', a: 'away' };
  let relayLastKey = '';
  let relayLastSentAt = 0;
  let relayTimer = null;
  let relayHeartbeat = null;
  let relaySource = null;
  let viewerAppliedTs = 0;
  let viewerLastKind = 'p2p';
  let livePeer = null;
  let liveConns = [];
  let liveHeartbeat = null;
  let liveLastSent = '';
  let viewerConn = null;
  let viewerRetry = null;
  let viewerWatch = null;
  let viewerStaleTimer = null;
  let viewerLastMsg = 0;
  let demoTimer = null;

  // Groups: a group is a table or sector holding several seats. Empty groups are kept here so they
  // show up as chips before any seat is drawn; groups with seats also live in each zone's `group`.
  const GROUPS_KEY = 'hubvision.groups.v1';
  let customGroups = loadGroups();
  let activeGroup = '';

  function loadSensitivity() {
    try {
      const saved = parseFloat(localStorage.getItem(SENSITIVITY_KEY));
      return Number.isFinite(saved) && saved >= 0.15 && saved <= 0.9 ? saved : 0.35;
    } catch {
      return 0.35;
    }
  }

  function loadGroups() {
    try {
      const saved = JSON.parse(localStorage.getItem(GROUPS_KEY));
      return Array.isArray(saved) ? saved : [];
    } catch {
      return [];
    }
  }

  function saveGroups() {
    try {
      localStorage.setItem(GROUPS_KEY, JSON.stringify(customGroups));
    } catch {
      // storage unavailable: groups last until reload
    }
  }

  function loadZones() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const saved = raw ? JSON.parse(raw) : [];
      return saved.map((z) => ({ ...z, occupied: false, status: 'free', lastSeenAt: null, objectSeenAt: null, pendingSince: null }));
    } catch {
      return [];
    }
  }

  function saveZones() {
    const persistent = zones.map(({ id, n, name, group, x, y, w, h }) => ({ id, n, name, group, x, y, w, h }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persistent));
  }

  // ---------- Model ----------
  // Two sizes of the same detector: "preciso" (mobilenet_v2) sees partly hidden or seated people better but
  // is slower; "rápido" (lite) keeps the box glued to a moving person. In "auto" the page times the precise
  // one on this very PC and switches to the fast one if a pass takes longer than AUTO_SWITCH_MS.
  const MODEL_PREF_KEY = 'hubvision.modelPref'; // 'auto' | 'rapido' | 'preciso'
  const AUTO_SWITCH_MS = 220;
  let modelPref = loadModelPref();
  let activeModelName = '';
  let modelLoading = false;

  function loadModelPref() {
    try {
      const saved = localStorage.getItem(MODEL_PREF_KEY);
      return saved === 'rapido' || saved === 'preciso' ? saved : 'auto';
    } catch {
      return 'auto';
    }
  }

  // Average time of one detection pass, after a warm-up pass (the first one compiles the GPU programs).
  async function timeModel(candidate) {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const c = canvas.getContext('2d');
    for (let i = 0; i < 40; i++) {
      c.fillStyle = 'hsl(' + ((i * 37) % 360) + ',60%,' + (20 + ((i * 13) % 60)) + '%)';
      c.fillRect((i * 53) % 640, (i * 29) % 360, 120, 90);
    }
    await candidate.detect(canvas, 5, 0.9);
    const times = [];
    for (let i = 0; i < 4; i++) {
      const started = performance.now();
      await candidate.detect(canvas, 5, 0.9);
      times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);
    return (times[1] + times[2]) / 2;
  }

  async function loadModel() {
    if (modelLoading) return;
    modelLoading = true;
    const choice = document.getElementById('modelChoice');
    if (choice) choice.disabled = true;
    const previous = model;
    model = null;
    updateToggleAvailability();
    modelStatus.textContent = 'Cargando modelo…';
    modelStatus.classList.remove('ready', 'error');
    try {
      let base = modelPref === 'rapido' ? 'lite_mobilenet_v2' : 'mobilenet_v2';
      let candidate;
      try {
        candidate = await cocoSsd.load({ base });
      } catch (err) {
        console.warn(base + ' unavailable, using the default model', err);
        base = 'lite_mobilenet_v2';
        candidate = await cocoSsd.load({ base });
      }
      let ms = await timeModel(candidate);
      if (modelPref === 'auto' && base === 'mobilenet_v2' && ms > AUTO_SWITCH_MS) {
        candidate.dispose();
        base = 'lite_mobilenet_v2';
        candidate = await cocoSsd.load({ base });
        ms = await timeModel(candidate);
      }
      model = candidate;
      if (previous && previous !== candidate) previous.dispose();
      activeModelName = base === 'mobilenet_v2' ? 'preciso' : 'rápido';
      modelStatus.textContent = 'Modelo ' + activeModelName + ' listo · ' + Math.round(ms) + ' ms';
      modelStatus.classList.add('ready');
    } catch (err) {
      modelStatus.textContent = 'Error cargando el modelo';
      modelStatus.classList.add('error');
      console.error(err);
    } finally {
      modelLoading = false;
      if (choice) choice.disabled = false;
      updateToggleAvailability();
    }
  }
  let modelRequested = false;
  function ensureModel() {
    if (modelRequested) return;
    modelRequested = true;
    loadModel();
  }

  // ---------- Admin login ----------
  function isAdmin() {
    try {
      return sessionStorage.getItem(ADMIN_KEY) === '1';
    } catch {
      return document.body.classList.contains('is-admin');
    }
  }

  function applyRole() {
    const admin = isAdmin();
    document.body.classList.toggle('is-admin', admin);
    adminBtn.textContent = admin ? 'Cerrar sesión' : 'Admin';
    if (admin) {
      clearInterval(demoTimer);
      stopViewerAll();
      zones = loadZones();
      zoneCounter = zones.reduce((max, z) => Math.max(max, z.n || 0), 0);
      renderTableList();
      startLiveHost();
      startRelayHost();
      ensureModel();
      zoneHint.textContent = defaultZoneHint();
      // No source is preselected: the admin picks one (the webcam prompt used to block the page on load).
      const checked = document.querySelector('input[name="source"]:checked');
      if (checked && checked.value === 'webcam' && !webcamStream) startWebcam();
    } else {
      stopDetection();
      stopLiveHost();
      stopRelayHost();
      stopWebcam();
      stopPhone();
      stopIpcam();
      activeMedia = null;
      updateToggleAvailability();
      // The public view shows what the admin session publishes, never this browser's saved tables.
      zones = [];
      viewerAppliedTs = 0;
      renderTableList();
      if (urlParams.has('demo')) {
        startDemo();
      } else {
        startViewerClock();
        startRelayViewer();
        startLiveViewer();
      }
    }
  }

  // ?demo=1 fills the public view with sample groups that change over time, to preview the design.
  function startDemo() {
    clearInterval(demoTimer);
    const sample = [['Mesa A', 4], ['Mesa B', 6], ['Mesa C', 4], ['Zona ventanal', 5]];
    zones = [];
    sample.forEach(([group, count]) => {
      for (let i = 1; i <= count; i++) {
        const busy = Math.random() < 0.55;
        zones.push({ id: 'demo' + zones.length, name: 'Puesto ' + i, group, status: busy ? 'busy' : 'free', occupied: busy });
      }
    });
    viewerLastMsg = Date.now();
    setLiveStatus('Demostración con datos de ejemplo', true);
    pubUpdatedEl.textContent = 'Datos de ejemplo';
    renderTableList();
    demoTimer = setInterval(() => {
      if (isAdmin()) return;
      const z = zones[Math.floor(Math.random() * zones.length)];
      z.occupied = !z.occupied;
      z.status = z.occupied ? 'busy' : 'free';
      renderTableList();
    }, 3000);
  }

  // Hub Providencia cowork hours: Monday to Thursday 08:30-18:00, Friday until 17:00, closed on weekends.
  const OPEN_HOURS = { Mon: [510, 1080], Tue: [510, 1080], Wed: [510, 1080], Thu: [510, 1080], Fri: [510, 1020] };
  const DAY_ORDER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const DAY_ES = { Mon: 'lunes', Tue: 'martes', Wed: 'miércoles', Thu: 'jueves', Fri: 'viernes', Sat: 'sábado', Sun: 'domingo' };

  function fmtTime(min) {
    return Math.floor(min / 60) + ':' + String(min % 60).padStart(2, '0');
  }

  function hubOpenStatus() {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Santiago',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date());
    const get = (type) => parts.find((p) => p.type === type).value;
    const day = get('weekday');
    const minutes = (parseInt(get('hour'), 10) % 24) * 60 + parseInt(get('minute'), 10);
    const today = OPEN_HOURS[day];
    if (today && minutes >= today[0] && minutes < today[1]) {
      return { open: true, text: 'Abierto ahora · cierra a las ' + fmtTime(today[1]) };
    }
    if (today && minutes < today[0]) {
      return { open: false, text: 'Cerrado · abre hoy a las ' + fmtTime(today[0]) };
    }
    const index = DAY_ORDER.indexOf(day);
    for (let step = 1; step <= 7; step++) {
      const next = DAY_ORDER[(index + step) % 7];
      if (OPEN_HOURS[next]) {
        const when = step === 1 ? 'mañana' : 'el ' + DAY_ES[next];
        return { open: false, text: 'Cerrado · abre ' + when + ' a las ' + fmtTime(OPEN_HOURS[next][0]) };
      }
    }
    return { open: false, text: 'Cerrado' };
  }

  function renderOpenStatus() {
    const status = hubOpenStatus();
    pubOpenEl.textContent = status.text;
    pubOpenEl.classList.toggle('is-open', status.open);
    pubOpenEl.classList.toggle('is-closed', !status.open);
  }
  setInterval(renderOpenStatus, 60000);

  // ---------- Live sharing between admin and public view (WebRTC data channel via PeerJS) ----------
  function liveSnapshot() {
    return {
      type: 'state',
      ts: Date.now(),
      detecting,
      zones: zones.map((z) => ({ id: z.id, name: z.name, group: z.group || '', status: z.status || 'free', occupied: !!z.occupied })),
    };
  }

  // ---- Relay (admin side) ----
  function relayBody(isDetecting) {
    return JSON.stringify({
      t: Date.now(),
      d: isDetecting ? 1 : 0,
      z: zones.map((z) => [z.name, z.group || '', STATUS_TO_CODE[z.status || 'free'] || 'f']),
    });
  }

  function sendRelay() {
    relayLastSentAt = Date.now();
    fetch(RELAY_URL, { method: 'POST', body: relayBody(detecting) }).catch(() => {
      // offline or blocked: the next change tries again
    });
  }

  function publishRelay(force) {
    if (!isAdmin()) return;
    const key = JSON.stringify([detecting, zones.map((z) => [z.name, z.group, z.status])]);
    if (!force && key === relayLastKey) return;
    relayLastKey = key;
    clearTimeout(relayTimer);
    relayTimer = setTimeout(sendRelay, Math.max(0, RELAY_MIN_GAP_MS - (Date.now() - relayLastSentAt)));
  }

  function startRelayHost() {
    clearInterval(relayHeartbeat);
    relayHeartbeat = setInterval(() => publishRelay(true), RELAY_HEARTBEAT_MS);
    relayLastKey = '';
    publishRelay(true);
  }

  function stopRelayHost() {
    clearInterval(relayHeartbeat);
    clearTimeout(relayTimer);
    relayHeartbeat = null;
  }

  // Tell the public view that monitoring ended (best effort: sendBeacon survives closing the tab).
  function announceOffline() {
    if (!isAdmin() || !navigator.sendBeacon) return;
    navigator.sendBeacon(RELAY_URL, relayBody(false));
  }

  window.addEventListener('pagehide', announceOffline);

  function broadcastLive(force) {
    publishRelay(false);
    if (!livePeer || !liveConns.length) return;
    const snap = liveSnapshot();
    const key = JSON.stringify([snap.detecting, snap.zones]);
    if (!force && key === liveLastSent) return;
    liveLastSent = key;
    liveConns.forEach((c) => {
      if (c.open) c.send(snap);
    });
  }

  function startLiveHost() {
    if (typeof Peer === 'undefined' || livePeer) return;
    const peer = new Peer(LIVE_PEER_ID);
    livePeer = peer;
    peer.on('connection', (conn) => {
      const drop = () => {
        liveConns = liveConns.filter((c) => c !== conn);
      };
      conn.on('open', () => {
        liveConns.push(conn);
        conn.send(liveSnapshot());
      });
      conn.on('close', drop);
      conn.on('error', drop);
    });
    peer.on('disconnected', () => {
      if (!peer.destroyed) peer.reconnect();
    });
    peer.on('error', () => {
      // The id may still be held by a previous tab, or the signaling server was unreachable: retry shortly.
      stopLiveHost();
      setTimeout(() => {
        if (isAdmin()) startLiveHost();
      }, 5000);
    });
    liveHeartbeat = setInterval(() => broadcastLive(true), 5000);
  }

  function stopLiveHost() {
    clearInterval(liveHeartbeat);
    liveHeartbeat = null;
    liveConns.forEach((c) => c.close());
    liveConns = [];
    if (livePeer) {
      livePeer.destroy();
      livePeer = null;
    }
  }

  function setLiveStatus(text, ok) {
    liveStatusEl.hidden = false;
    liveStatusEl.textContent = text;
    liveStatusEl.classList.toggle('ok', !!ok);
  }

  const NO_LIVE_INFO = 'Sin información en vivo por ahora';

  // Only speak about the P2P link when no data has arrived from anywhere yet (the relay may be delivering).
  function p2pNote(text) {
    if (!viewerLastMsg) setLiveStatus(text);
  }

  // One entry point for what the public view shows, whichever way the data came (direct link or relay).
  function applySnapshot(list, isDetecting, ts, kind, receivedAt) {
    if (ts < viewerAppliedTs) return; // older than what is already shown (e.g. the relay replaying its last post)
    viewerAppliedTs = ts;
    viewerLastMsg = receivedAt;
    viewerLastKind = kind;
    zones = list;
    setLiveStatus(isDetecting ? 'En vivo' : 'Última información disponible', isDetecting);
    renderTableList();
  }

  function ageText(secs) {
    return secs < 90 ? secs + ' s' : Math.round(secs / 60) + ' min';
  }

  function startViewerClock() {
    clearInterval(viewerStaleTimer);
    viewerStaleTimer = setInterval(() => {
      if (!viewerLastMsg) return;
      const secs = Math.max(0, Math.floor((Date.now() - viewerLastMsg) / 1000));
      pubUpdatedEl.textContent = secs < 5 ? 'Actualizado ahora' : 'Actualizado hace ' + ageText(secs);
      const limit = viewerLastKind === 'relay' ? RELAY_FRESH_S : 15;
      if (secs > limit) setLiveStatus(NO_LIVE_INFO + ' (datos de hace ' + ageText(secs) + ')', false);
    }, 1000);
  }

  // ---- Relay (public side) ----
  function startRelayViewer() {
    if (relaySource || typeof EventSource === 'undefined') return;
    relaySource = new EventSource(RELAY_URL + '/sse?since=latest'); // replays the last post, then streams new ones
    relaySource.onmessage = (event) => {
      try {
        const wrapper = JSON.parse(event.data);
        if (wrapper.event !== 'message') return;
        const snap = JSON.parse(wrapper.message);
        const sentAt = (wrapper.time || 0) * 1000;
        if (Date.now() - sentAt > RELAY_MAX_AGE_MS) return;
        const list = snap.z.map(([name, group, code], i) => {
          const status = CODE_TO_STATUS[code] || 'free';
          return { id: 'r' + i, name, group, status, occupied: status !== 'free' };
        });
        applySnapshot(list, !!snap.d, snap.t, 'relay', sentAt);
      } catch {
        // ignore malformed posts
      }
    };
    // EventSource reconnects by itself if the connection drops.
  }

  function stopRelayViewer() {
    if (relaySource) {
      relaySource.close();
      relaySource = null;
    }
  }

  function startLiveViewer() {
    if (livePeer) return;
    if (typeof Peer === 'undefined') {
      p2pNote(NO_LIVE_INFO);
      return;
    }
    p2pNote('Conectando…');
    const peer = new Peer();
    livePeer = peer;
    peer.on('open', connectToHost);
    peer.on('disconnected', () => {
      if (!peer.destroyed) peer.reconnect();
    });
    peer.on('error', (err) => {
      if (err.type === 'peer-unavailable') {
        p2pNote(NO_LIVE_INFO);
        scheduleViewerRetry();
      } else {
        stopLiveViewer();
        p2pNote(NO_LIVE_INFO);
        setTimeout(() => {
          if (!isAdmin()) startLiveViewer();
        }, 5000);
      }
    });
  }

  function connectToHost() {
    if (!livePeer || livePeer.destroyed || isAdmin()) return;
    if (viewerConn) viewerConn.close();
    const conn = livePeer.connect(LIVE_PEER_ID, { reliable: true });
    viewerConn = conn;
    // If nothing arrives (for example the two networks cannot reach each other), say so and try again.
    clearTimeout(viewerWatch);
    viewerWatch = setTimeout(() => {
      if (!viewerLastMsg && !isAdmin()) {
        p2pNote(NO_LIVE_INFO);
        scheduleViewerRetry();
      }
    }, 12000);
    conn.on('data', (msg) => {
      if (!msg || msg.type !== 'state' || !Array.isArray(msg.zones)) return;
      applySnapshot(msg.zones.map((z) => ({ ...z })), !!msg.detecting, msg.ts || Date.now(), 'p2p', Date.now());
    });
    conn.on('close', () => {
      if (viewerLastKind === 'p2p') p2pNote('Reconectando…');
      scheduleViewerRetry();
    });
  }

  function scheduleViewerRetry() {
    clearTimeout(viewerRetry);
    viewerRetry = setTimeout(() => {
      if (!isAdmin() && livePeer && !livePeer.destroyed) connectToHost();
    }, 5000);
  }

  // Stops only the direct (browser-to-browser) viewer link; the relay and what is shown stay as they are.
  function stopLiveViewer() {
    clearTimeout(viewerRetry);
    clearTimeout(viewerWatch);
    if (viewerConn) {
      viewerConn.close();
      viewerConn = null;
    }
    if (livePeer && !liveConns.length && !liveHeartbeat) {
      livePeer.destroy();
      livePeer = null;
    }
  }

  // Stops everything the public view uses (used when an admin session starts).
  function stopViewerAll() {
    stopLiveViewer();
    stopRelayViewer();
    clearInterval(viewerStaleTimer);
    viewerLastMsg = 0;
    viewerAppliedTs = 0;
    liveStatusEl.hidden = true;
  }

  adminBtn.addEventListener('click', () => {
    if (isAdmin()) {
      announceOffline();
      try {
        sessionStorage.removeItem(ADMIN_KEY);
      } catch {
        // storage unavailable
      }
      document.body.classList.remove('is-admin');
      applyRole();
      return;
    }
    loginError.hidden = true;
    loginForm.reset();
    loginDialog.showModal();
    loginUser.focus();
  });

  loginCancel.addEventListener('click', () => loginDialog.close());

  loginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (loginUser.value.trim() === ADMIN_USER && loginPass.value === ADMIN_PASS) {
      try {
        sessionStorage.setItem(ADMIN_KEY, '1');
      } catch {
        // storage unavailable: role only lasts until reload
      }
      document.body.classList.add('is-admin');
      loginDialog.close();
      applyRole();
    } else {
      loginError.hidden = false;
    }
  });

  // ---------- Media source ----------
  // "click" (not "change") so choosing the already selected source retries it.
  sourceRadios.forEach((r) => r.addEventListener('click', onSourceChange));

  function onSourceChange(e) {
    stopDetection();
    stopPhone();
    sourceRadios.forEach((r) => r.closest('label').classList.toggle('active', r.checked));
    startScreenBtn.hidden = e.target.value !== 'screen';
    if (e.target.value === 'webcam') {
      ipcamUrlWrap.hidden = true;
      stopIpcam();
      stopWebcam();
      startWebcam();
    } else if (e.target.value === 'screen') {
      ipcamUrlWrap.hidden = true;
      stopIpcam();
      stopWebcam();
      startScreen();
    } else if (e.target.value === 'phone') {
      ipcamUrlWrap.hidden = true;
      stopIpcam();
      stopWebcam();
      activeMedia = null;
      video.hidden = true;
      stageEmpty.hidden = true;
      updateToggleAvailability();
      startPhone();
    } else {
      ipcamUrlWrap.hidden = false;
      stopWebcam();
      activeMedia = null;
      video.hidden = true;
      stageEmpty.hidden = false;
      stageEmpty.textContent = 'Ingresa la URL de la cámara WiFi y presiona Conectar';
      updateToggleAvailability();
    }
  }

  // ---------- Phone camera over WebRTC (QR pairing) ----------
  function startPhone() {
    if (typeof Peer === 'undefined' || typeof QRCode === 'undefined') {
      phonePanel.hidden = false;
      phoneStatus.textContent = 'No se pudieron cargar las librerías de conexión. Revisa tu internet.';
      return;
    }
    const id = 'hubvision-' + Math.random().toString(36).slice(2, 12);
    phonePanel.hidden = false;
    phoneStatus.textContent = 'Preparando conexión…';
    qrBox.innerHTML = '';

    const peer = new Peer(id);
    phonePeer = peer;

    peer.on('open', () => {
      const link = location.origin + location.pathname + '?cam=' + id;
      qrBox.innerHTML = '';
      new QRCode(qrBox, { text: link, width: 200, height: 200 });
      phoneStatus.textContent = 'Esperando al celular…';
      // Fallback when the phone's scanner only reads the code: open or copy the same link.
      phoneLink.href = link;
      phoneLink.textContent = link;
      phoneLink.hidden = false;
      copyPhoneLinkBtn.hidden = false;
      copyPhoneLinkBtn.textContent = 'Copiar enlace';
    });

    peer.on('call', (call) => {
      if (phoneCall) phoneCall.close();
      phoneCall = call;
      call.answer();
      call.on('stream', (remote) => {
        video.srcObject = remote;
        video.hidden = false;
        img.hidden = true;
        phonePanel.hidden = true;
        stageEmpty.hidden = true;
        activeMedia = 'video';
        video.play().catch(() => {});
        updateToggleAvailability();
      });
      call.on('close', () => {
        if (phoneCall !== call) return;
        stopDetection();
        video.srcObject = null;
        video.hidden = true;
        activeMedia = null;
        phonePanel.hidden = false;
        phoneStatus.textContent = 'El celular se desconectó. Esperando de nuevo…';
        updateToggleAvailability();
      });
    });

    peer.on('error', (err) => {
      phoneStatus.textContent = 'Error de conexión (' + err.type + '). Vuelve a elegir esta opción.';
    });
  }

  copyPhoneLinkBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(phoneLink.href);
      copyPhoneLinkBtn.textContent = 'Enlace copiado';
    } catch {
      copyPhoneLinkBtn.textContent = 'Copia el enlace a mano';
    }
  });

  function stopPhone() {
    phoneLink.hidden = true;
    copyPhoneLinkBtn.hidden = true;
    if (phoneCall) {
      const call = phoneCall;
      phoneCall = null;
      call.close();
    }
    if (phonePeer) {
      phonePeer.destroy();
      phonePeer = null;
    }
    phonePanel.hidden = true;
    qrBox.innerHTML = '';
    if (!webcamStream) video.srcObject = null;
  }

  async function startWebcam() {
    try {
      webcamStream = await navigator.mediaDevices.getUserMedia({ video: true });
      video.srcObject = webcamStream;
      video.hidden = false;
      img.hidden = true;
      stageEmpty.hidden = true;
      activeMedia = 'video';
      await video.play();
      updateToggleAvailability();
    } catch (err) {
      stageEmpty.hidden = false;
      const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
      stageEmpty.textContent = denied
        ? 'El navegador no permitió usar la webcam. Revisa el permiso de cámara (candado junto a la dirección) o elige otra fuente.'
        : 'No se pudo acceder a la webcam: ' + err.message;
      activeMedia = null;
      updateToggleAvailability();
    }
  }

  // Clicking an already selected radio fires no event, so sharing can be restarted from this button.
  startScreenBtn.addEventListener('click', () => {
    stopDetection();
    stopWebcam();
    startScreen();
  });

  // Test source: capture a screen or window where another app (e.g. a camera's own app) shows the video.
  async function startScreen() {
    try {
      // Hide the "entire screen" choice (it would capture this page too); browsers that lack these hints ignore them.
      webcamStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
        monitorTypeSurfaces: 'exclude',
        selfBrowserSurface: 'exclude',
      });
      webcamStream.getVideoTracks()[0].addEventListener('ended', () => {
        stopDetection();
        stopWebcam();
        video.hidden = true;
        activeMedia = null;
        stageEmpty.hidden = false;
        stageEmpty.textContent = 'Se dejó de compartir. Pulsa "Elegir ventana a compartir" para reanudar.';
        updateToggleAvailability();
      });
      video.srcObject = webcamStream;
      video.hidden = false;
      img.hidden = true;
      stageEmpty.hidden = true;
      activeMedia = 'video';
      await video.play();
      updateToggleAvailability();
    } catch (err) {
      stageEmpty.hidden = false;
      stageEmpty.textContent = 'No se pudo capturar la pantalla: ' + err.message;
      activeMedia = null;
      updateToggleAvailability();
    }
  }

  function stopWebcam() {
    if (webcamStream) {
      webcamStream.getTracks().forEach((t) => t.stop());
      webcamStream = null;
    }
    video.srcObject = null;
  }

  // ---------- WiFi camera (MJPEG URL) with diagnosis and automatic reconnection ----------
  const IPCAM_URL_KEY = 'hubvision.ipcamUrl';
  const DEFAULT_IPCAM_URL = 'http://127.0.0.1:8090/video'; // tools/iniciar-emulador.bat serves the emulator here
  let ipcamTarget = '';
  let ipcamWatch = null;
  let ipcamProblem = null; // null | 'down' | 'stale' | 'blocked'

  try {
    ipcamUrlInput.value = localStorage.getItem(IPCAM_URL_KEY) || DEFAULT_IPCAM_URL;
  } catch {
    ipcamUrlInput.value = DEFAULT_IPCAM_URL;
  }

  // The Windows link registered by tools/instalar-conexion.bat: it opens the emulator tool on demand.
  const LAUNCH_URL = 'hubvision-emulador://iniciar';
  let lastLaunch = 0;
  let startWhenReady = false; // "Iniciar detección" was pressed while the video was not there yet

  function isLocalHelper(url) {
    const base = ipcamBase(url);
    return !!base && base.hostname === '127.0.0.1' && base.port === '8090';
  }

  function launchEmulatorTool() {
    if (Date.now() - lastLaunch < 15000) return;
    lastLaunch = Date.now();
    const link = document.createElement('a');
    link.href = LAUNCH_URL;
    link.click();
  }

  const IPCAM_MESSAGES = {
    starting:
      'Abriendo el programa del emulador… Si el navegador pregunta si permite abrirlo, acepta y marca recordar. ' +
      'Si nunca se abre, ejecuta una vez tools\\instalar-conexion.bat.',
    down:
      'No llega el video de la cámara. HubVision se reconecta solo apenas vuelva. ' +
      'Si usas el emulador, abre tools\\iniciar-emulador.bat y deja esa ventana abierta.',
    stale:
      'El emulador no está mostrando video nuevo. Abre la cámara de Maxi-Cosi en vivo; HubVision sigue solo.',
    blocked:
      'No se pudo cargar el video. Revisa la dirección y que la cámara permita acceso desde el navegador (CORS).',
  };

  function setIpcamProblem(kind) {
    // With no problem the overlay must always be hidden: it may still hold the "enter the URL" prompt.
    if (ipcamProblem === kind && kind !== null) return;
    ipcamProblem = kind;
    if (kind) {
      stageEmpty.hidden = false;
      stageEmpty.classList.add('alert');
      stageEmpty.textContent = IPCAM_MESSAGES[kind];
      activeMedia = null;
    } else {
      stageEmpty.hidden = true;
      stageEmpty.classList.remove('alert');
    }
    updateToggleAvailability();
  }

  function ipcamBase(url) {
    try {
      return new URL(url);
    } catch {
      return null;
    }
  }

  // 'up' (reachable), 'stale' (the local emulator tool answers but has no recent image) or 'down'.
  async function probeIpcam(url) {
    const base = ipcamBase(url);
    if (!base) return 'down';
    const probeUrl = base.origin + '/frame.jpg?probe=' + Date.now();
    try {
      const res = await fetch(probeUrl, { cache: 'no-store' });
      return res.status === 503 ? 'stale' : 'up';
    } catch {
      try {
        await fetch(probeUrl, { mode: 'no-cors', cache: 'no-store' });
        return 'up'; // reachable but it does not allow reading (CORS): not a connection problem
      } catch {
        return 'down';
      }
    }
  }

  function openIpcam(url, fresh) {
    const base = ipcamBase(url);
    const local = base && (base.hostname === '127.0.0.1' || base.hostname === 'localhost');
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      setIpcamProblem(null);
      activeMedia = 'img';
      updateToggleAvailability();
      if (startWhenReady) {
        startWhenReady = false;
        startDetection();
      }
    };
    img.onerror = async () => {
      const state = await probeIpcam(url);
      setIpcamProblem(state === 'up' ? 'blocked' : state);
    };
    // A new query string forces a fresh connection when the previous stream died (local tool only).
    img.src = fresh && local ? url + (url.includes('?') ? '&' : '?') + 't=' + Date.now() : url;
    img.hidden = false;
  }

  function startIpcamWatch() {
    clearInterval(ipcamWatch);
    ipcamWatch = setInterval(async () => {
      if (!ipcamTarget) return;
      const state = await probeIpcam(ipcamTarget);
      if (state === 'down' && Date.now() - lastLaunch < 15000 && isLocalHelper(ipcamTarget)) {
        setIpcamProblem('starting'); // just asked Windows to open the tool: give it a moment
      } else if (state === 'down' || state === 'stale') {
        setIpcamProblem(state);
      } else if (ipcamProblem === 'down' || ipcamProblem === 'stale' || ipcamProblem === 'starting') {
        openIpcam(ipcamTarget, true); // it is back: reconnect without any click
      }
    }, 3000);
  }

  connectIpcamBtn.addEventListener('click', async () => {
    const url = ipcamUrlInput.value.trim();
    if (!url) return;
    stopDetection();
    stopWebcam();
    video.hidden = true;
    ipcamTarget = url;
    ipcamProblem = null;
    try {
      localStorage.setItem(IPCAM_URL_KEY, url);
    } catch {
      // storage unavailable: the URL is not remembered
    }
    // If the emulator tool is not running, ask Windows to open it (the click is the user's permission).
    if (isLocalHelper(url) && (await probeIpcam(url)) === 'down') launchEmulatorTool();
    openIpcam(url, false);
    startIpcamWatch();
    updateToggleAvailability();
  });

  function stopIpcam() {
    clearInterval(ipcamWatch);
    ipcamWatch = null;
    ipcamTarget = '';
    ipcamProblem = null;
    stageEmpty.classList.remove('alert');
    img.onload = null;
    img.onerror = null;
    img.src = '';
    img.hidden = true;
  }

  function updateToggleAvailability() {
    // With a WiFi camera selected the button stays usable even if the video is not there yet:
    // pressing it opens the emulator tool and starts detecting as soon as the video arrives.
    toggleDetectionBtn.disabled = !(model && (activeMedia || ipcamTarget));
  }

  // ---------- Detection ----------
  toggleDetectionBtn.addEventListener('click', () => {
    if (detecting || startWhenReady) {
      startWhenReady = false;
      stopDetection();
    } else if (!activeMedia && ipcamTarget) {
      startWhenReady = true;
      toggleDetectionBtn.textContent = 'Esperando el video… (cancelar)';
      if (isLocalHelper(ipcamTarget)) launchEmulatorTool();
      setIpcamProblem(isLocalHelper(ipcamTarget) ? 'starting' : 'down');
    } else {
      startDetection();
    }
  });

  // Detection runs back to back (each pass starts when the previous one ends, with a short pause so the
  // page stays responsive) instead of on a fixed 0.7 s timer, so it samples as fast as the PC allows.
  const MIN_DETECT_GAP_MS = 60;
  let detectLoopRunning = false;
  let latestDetectMs = 0;
  let lastRenderSignature = '';

  function startDetection() {
    if (!model || !activeMedia) return;
    detecting = true;
    toggleDetectionBtn.textContent = 'Detener detección';
    broadcastLive(true);
    if (!detectLoopRunning) detectLoop();
  }

  async function detectLoop() {
    detectLoopRunning = true;
    while (detecting) {
      const started = performance.now();
      await runDetection();
      latestDetectMs = performance.now() - started;
      await new Promise((resolve) => setTimeout(resolve, Math.max(MIN_DETECT_GAP_MS - latestDetectMs, 0)));
    }
    detectLoopRunning = false;
  }

  function stopDetection() {
    detecting = false;
    toggleDetectionBtn.textContent = 'Iniciar detección';
    broadcastLive(true);
  }

  // tfjs reads an <img> at its on-screen (CSS) size, stretching it to the element's box: that distorts the
  // picture and shifts every box it returns. Drawing the frame at its own proportions into a canvas (also
  // scaled down, which is faster and enough for the model) keeps both the image and the coordinates right.
  const detectCanvas = document.createElement('canvas');
  const detectCtx = detectCanvas.getContext('2d');
  const DETECT_MAX_WIDTH = 640;

  let usingHelperFrames = false;
  let latestFrameAgeMs = 0;

  async function grabHelperFrame() {
    const base = ipcamBase(ipcamTarget);
    if (!base) return null;
    const res = await fetch(base.origin + '/frame.jpg?t=' + Date.now(), { cache: 'no-store' });
    if (res.status !== 200) return null;
    latestFrameAgeMs = Number(res.headers.get('X-Frame-Age')) || 0;
    return createImageBitmap(await res.blob());
  }

  function detectionInput(mediaEl, size) {
    const scale = Math.min(1, DETECT_MAX_WIDTH / size.width);
    const w = Math.round(size.width * scale);
    const h = Math.round(size.height * scale);
    if (detectCanvas.width !== w) detectCanvas.width = w;
    if (detectCanvas.height !== h) detectCanvas.height = h;
    detectCtx.drawImage(mediaEl, 0, 0, w, h);
    return detectCanvas;
  }

  function getMediaEl() {
    return activeMedia === 'video' ? video : activeMedia === 'img' ? img : null;
  }

  function getNaturalSize() {
    if (activeMedia === 'video') return { width: video.videoWidth, height: video.videoHeight };
    if (activeMedia === 'img') return { width: img.naturalWidth, height: img.naturalHeight };
    return null;
  }

  async function runDetection() {
    if (!model) return; // the model is being (re)loaded
    let mediaEl = getMediaEl();
    let size = getNaturalSize();
    if (!mediaEl || !size || !size.width || !size.height) return;

    // With the local emulator tool, ask it for its latest frame instead of copying the continuous video:
    // the picture analysed is then always the newest one, whatever the browser does with the stream.
    let bitmap = null;
    usingHelperFrames = false;
    if (activeMedia === 'img' && isLocalHelper(ipcamTarget)) {
      try {
        bitmap = await grabHelperFrame();
      } catch {
        bitmap = null;
      }
      if (!bitmap) return;
      usingHelperFrames = true;
      mediaEl = bitmap;
      size = { width: bitmap.width, height: bitmap.height };
    }

    let predictions;
    let input;
    try {
      input = detectionInput(mediaEl, size);
      // coco-ssd drops everything below minScore (default 0.5) itself, so ask for low scores
      // and let the sensitivity setting decide what counts.
      predictions = await model.detect(input, 20, 0.15);
    } catch (err) {
      console.error('Detection error', err);
      stopDetection();
      modelStatus.textContent = 'Error de detección (¿CORS del stream?)';
      modelStatus.classList.add('error');
      return;
    }

    if (bitmap) bitmap.close();

    // Boxes come back in the pixels of the canvas the model saw: normalise by that size.
    const iw = input.width;
    const ih = input.height;
    latestMaxScore = predictions.reduce((max, p) => (p.class === 'person' ? Math.max(max, p.score) : max), 0);
    latestPersons = predictions
      .filter((p) => p.class === 'person' && p.score >= personMinScore)
      .map((p) => {
        const box = { x: p.bbox[0] / iw, y: p.bbox[1] / ih, w: p.bbox[2] / iw, h: p.bbox[3] / ih };
        box.core = personCore(box);
        return box;
      });

    const objects = predictions
      .filter((p) => OBJECT_CLASSES.includes(p.class) && p.score > OBJECT_MIN_SCORE)
      .map((p) => ({
        cx: (p.bbox[0] + p.bbox[2] / 2) / iw,
        cy: (p.bbox[1] + p.bbox[3] / 2) / ih,
      }));

    const now = Date.now();
    const presentIds = assignPersonsToZones(latestPersons);
    zones.forEach((zone) => updateZoneStatus(zone, objects, now, presentIds));

    // Rebuilding the list on every pass is wasteful now that passes are frequent: only when a state changed.
    const signature = zones
      .map((z) => {
        const left = z.status === 'grace' ? Math.ceil(Math.max(0, GRACE_MS - (now - z.lastSeenAt)) / 60000) : '';
        return z.id + ':' + z.status + ':' + z.occupied + ':' + left;
      })
      .join('|');
    if (signature !== lastRenderSignature) {
      lastRenderSignature = signature;
      renderTableList();
    }
  }

  // The area of a person that counts for seats: torso, hips and legs (the central half of the box, lower 55 %).
  // The full box also takes in arms, a bent body or a walking stride, and would cover neighbouring seats.
  function personCore(p) {
    return { x: p.x + p.w * 0.25, y: p.y + p.h * 0.4, w: p.w * 0.5, h: p.h * 0.55 };
  }

  // Each person occupies at most ONE seat, and each seat holds at most one person: the pairs (person, seat) are
  // taken from the best match down, so two people sitting side by side do not both claim the same seat, and a
  // seat next to the one a person sits on is never marked just because their body spills over it.
  function assignPersonsToZones(persons) {
    const candidates = [];
    persons.forEach((p, pi) => {
      const core = p.core;
      const cx = core.x + core.w / 2;
      const cy = core.y + core.h / 2;
      zones.forEach((z) => {
        const cover = overlapRatio(core, z);
        const centreInside = cx >= z.x && cx <= z.x + z.w && cy >= z.y && cy <= z.y + z.h;
        if (cover < 0.3 && !centreInside) return;
        candidates.push({ pi, id: z.id, score: cover + (centreInside ? 0.5 : 0) });
      });
    });
    candidates.sort((a, b) => b.score - a.score);
    const present = new Set();
    const usedPersons = new Set();
    candidates.forEach((c) => {
      if (usedPersons.has(c.pi) || present.has(c.id)) return;
      usedPersons.add(c.pi);
      present.add(c.id);
    });
    return present;
  }

  // Someone who was only passing by (or a stray detection) must not leave a seat "held" for the grace period:
  // the grace period only applies to a seat that was really occupied for at least this long.
  const MIN_STAY_FOR_GRACE_MS = 15 * 1000;

  function updateZoneStatus(zone, objects, now, presentIds) {
    const personPresent = presentIds.has(zone.id);
    const objectNow = objects.some(
      (o) => o.cx >= zone.x && o.cx <= zone.x + zone.w && o.cy >= zone.y && o.cy <= zone.y + zone.h
    );
    if (objectNow) zone.objectSeenAt = now;
    const hasObjects = zone.objectSeenAt && now - zone.objectSeenAt < OBJECT_HOLD_MS;

    let rawStatus;
    if (personPresent) {
      zone.lastSeenAt = now;
      rawStatus = 'busy';
    } else if (zone.occupied && zone.occupiedSince && zone.lastSeenAt - zone.occupiedSince >= MIN_STAY_FOR_GRACE_MS) {
      // A seat that really was occupied: keep it held while the person is away (grace), or while belongings stay.
      const elapsed = now - zone.lastSeenAt;
      if (elapsed < GRACE_MS) rawStatus = 'grace';
      else if (hasObjects && elapsed < AWAY_MAX_MS) rawStatus = 'away';
      else rawStatus = 'free';
    } else {
      rawStatus = 'free'; // nobody there, and no confirmed stay to hold: it is available
    }

    // A change between occupied and available only shows once the new reading wins a vote over the
    // last CONFIRM_MS, so someone walking past a zone does not flip its state, and a detector that
    // misses a frame now and then (borderline confidence) does not restart the count.
    const rawOccupied = rawStatus !== 'free';
    const history = zone.history || (zone.history = []);
    history.push({ t: now, occ: rawOccupied });
    while (now - history[0].t > CONFIRM_MS) history.shift();

    if (rawOccupied === zone.occupied) zone.status = rawStatus;

    const covered = CONFIRM_MS === 0 || now - history[0].t >= CONFIRM_MS * 0.95;
    const opposite = history.filter((h) => h.occ !== zone.occupied).length / history.length;
    if (covered && opposite >= 0.75) {
      zone.occupied = !zone.occupied;
      zone.status = rawOccupied === zone.occupied ? rawStatus : zone.occupied ? 'busy' : 'free';
      zone.occupiedSince = zone.occupied ? now : null;
      if (!zone.occupied) zone.lastSeenAt = null;
      zone.history = [];
    }
  }

  const STATUS_LABELS = {
    busy: 'Ocupado',
    grace: 'Ocupado (ausencia temporal)',
    away: 'Ausente temporal (objetos)',
    free: 'Libre',
  };

  function overlapRatio(box, zone) {
    const ix = Math.max(box.x, zone.x);
    const iy = Math.max(box.y, zone.y);
    const iw = Math.min(box.x + box.w, zone.x + zone.w) - ix;
    const ih = Math.min(box.y + box.h, zone.y + zone.h) - iy;
    if (iw <= 0 || ih <= 0) return 0;
    const inter = iw * ih;
    const zoneArea = zone.w * zone.h;
    return zoneArea > 0 ? inter / zoneArea : 0;
  }

  // ---------- Zones: drawing ----------
  addZoneBtn.addEventListener('click', () => {
    isDrawingZone = true;
    addZoneBtn.classList.add('active');
    canvas.classList.add('drawing');
    zoneHint.textContent =
      'Arrastra sobre el video para dibujar el puesto' +
      (activeGroup ? ' del grupo ' + activeGroup : '') +
      ', o toca un punto para uno de tamaño estándar.';
  });

  document.getElementById('resetStates').addEventListener('click', () => {
    zones.forEach((z) => {
      z.occupied = false;
      z.status = 'free';
      z.lastSeenAt = null;
      z.occupiedSince = null;
      z.history = [];
    });
    lastRenderSignature = '';
    renderTableList();
  });

  clearZonesBtn.addEventListener('click', () => {
    if (zones.length && confirm('¿Borrar todos los puestos marcados?')) {
      zones = [];
      saveZones();
      renderTableList();
    }
  });

  function getContainRect() {
    const size = getNaturalSize();
    const rect = stage.getBoundingClientRect();
    if (!size || !size.width || !size.height) {
      return { x: 0, y: 0, width: rect.width, height: rect.height };
    }
    const stageRatio = rect.width / rect.height;
    const mediaRatio = size.width / size.height;
    let width, height;
    if (mediaRatio > stageRatio) {
      width = rect.width;
      height = rect.width / mediaRatio;
    } else {
      height = rect.height;
      width = rect.height * mediaRatio;
    }
    return { x: (rect.width - width) / 2, y: (rect.height - height) / 2, width, height };
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!isDrawingZone) return;
    canvas.setPointerCapture(e.pointerId);
    const rect = canvas.getBoundingClientRect();
    dragStart = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    dragCurrent = dragStart;
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!isDrawingZone || !dragStart) return;
    const rect = canvas.getBoundingClientRect();
    dragCurrent = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  });

  canvas.addEventListener('pointerup', (e) => {
    if (!isDrawingZone || !dragStart) return;
    const rect = canvas.getBoundingClientRect();
    dragCurrent = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    finishDrawingZone();
    canvas.releasePointerCapture(e.pointerId);
  });

  canvas.addEventListener('pointercancel', cancelDrawingZone);

  function finishDrawingZone() {
    if (!dragStart || !dragCurrent) return;
    const containRect = getContainRect();
    let x1 = Math.min(dragStart.x, dragCurrent.x);
    let y1 = Math.min(dragStart.y, dragCurrent.y);
    let x2 = Math.max(dragStart.x, dragCurrent.x);
    let y2 = Math.max(dragStart.y, dragCurrent.y);

    // A tap/click instead of a drag: create a default-size box centered on the point.
    if (x2 - x1 < 6 && y2 - y1 < 6) {
      const defaultW = containRect.width * 0.18;
      const defaultH = containRect.height * 0.18;
      x1 = dragStart.x - defaultW / 2;
      y1 = dragStart.y - defaultH / 2;
      x2 = dragStart.x + defaultW / 2;
      y2 = dragStart.y + defaultH / 2;
    }

    const fx = clamp01((x1 - containRect.x) / containRect.width);
    const fy = clamp01((y1 - containRect.y) / containRect.height);
    const fx2 = clamp01((x2 - containRect.x) / containRect.width);
    const fy2 = clamp01((y2 - containRect.y) / containRect.height);
    const fw = fx2 - fx;
    const fh = fy2 - fy;

    if (fw > 0.02 && fh > 0.02) {
      zoneCounter += 1;
      zones.push({
        id: 'z' + Date.now(),
        n: zoneCounter,
        name: 'Puesto ' + (zones.filter((z) => (z.group || '') === activeGroup).length + 1),
        group: activeGroup,
        x: fx,
        y: fy,
        w: fw,
        h: fh,
        occupied: false,
        status: 'free',
        lastSeenAt: null,
        objectSeenAt: null,
        pendingSince: null,
      });
      saveZones();
      renderTableList();
    }
    cancelDrawingZone();
  }

  function cancelDrawingZone() {
    isDrawingZone = false;
    addZoneBtn.classList.remove('active');
    canvas.classList.remove('drawing');
    dragStart = null;
    dragCurrent = null;
    zoneHint.textContent = defaultZoneHint();
  }

  function clamp01(v) {
    return Math.max(0, Math.min(1, v));
  }

  // ---------- Rendering ----------
  function resizeCanvas() {
    const rect = stage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  new ResizeObserver(resizeCanvas).observe(stage);
  resizeCanvas();

  function draw() {
    const rect = stage.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);
    const containRect = getContainRect();

    zones.forEach((zone) => {
      const x = containRect.x + zone.x * containRect.width;
      const y = containRect.y + zone.y * containRect.height;
      const w = zone.w * containRect.width;
      const h = zone.h * containRect.height;

      ctx.lineWidth = 2;
      const awayNow = zone.status === 'away' || zone.status === 'grace';
      const color = awayNow ? '#f59e0b' : zone.occupied ? '#ef4444' : '#22c55e';
      const tint = awayNow ? 'rgba(245,158,11,0.15)' : zone.occupied ? 'rgba(239,68,68,0.15)' : 'rgba(34,197,94,0.12)';
      ctx.strokeStyle = color;
      ctx.fillStyle = tint;
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);

      const label = zone.name + ' · ' + statusText(zone).toLowerCase();
      ctx.font = '13px Inter, sans-serif';
      const labelWidth = ctx.measureText(label).width + 10;
      ctx.fillStyle = color;
      ctx.fillRect(x, Math.max(0, y - 20), labelWidth, 20);
      ctx.fillStyle = '#06090f';
      ctx.fillText(label, x + 5, Math.max(14, y - 5));
    });

    if (detecting) {
      latestPersons.forEach((p) => {
        const x = containRect.x + p.x * containRect.width;
        const y = containRect.y + p.y * containRect.height;
        const w = p.w * containRect.width;
        const h = p.h * containRect.height;
        // The whole detection box, faint; and the core area that decides which seat a person holds, solid.
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(59,130,246,0.35)';
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(x, y, w, h);
        ctx.setLineDash([]);
        ctx.lineWidth = 2;
        ctx.strokeStyle = 'rgba(59,130,246,0.95)';
        ctx.fillStyle = 'rgba(59,130,246,0.12)';
        const cx0 = containRect.x + p.core.x * containRect.width;
        const cy0 = containRect.y + p.core.y * containRect.height;
        const cw = p.core.w * containRect.width;
        const ch = p.core.h * containRect.height;
        ctx.fillRect(cx0, cy0, cw, ch);
        ctx.strokeRect(cx0, cy0, cw, ch);
      });

      // Small readout to tune the sensitivity: the best "person" confidence seen vs. the threshold.
      const hud =
        (latestMaxScore > 0
          ? 'Persona: ' + latestMaxScore.toFixed(2) + ' · umbral ' + personMinScore.toFixed(2)
          : 'Persona: no detectada · umbral ' + personMinScore.toFixed(2)) +
        ' · ' + latestPersons.length + (latestPersons.length === 1 ? ' persona' : ' personas') +
        ' · ' + Math.round(latestDetectMs) + ' ms' +
        (usingHelperFrames ? ' · imagen de hace ' + latestFrameAgeMs + ' ms' : '');
      ctx.font = '12px Inter, sans-serif';
      const hudWidth = ctx.measureText(hud).width + 14;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(containRect.x + 8, containRect.y + 8, hudWidth, 22);
      ctx.fillStyle = latestMaxScore >= personMinScore ? '#4ade80' : '#fbbf24';
      ctx.fillText(hud, containRect.x + 15, containRect.y + 23);
    }

    if (isDrawingZone && dragStart && dragCurrent) {
      const x = Math.min(dragStart.x, dragCurrent.x);
      const y = Math.min(dragStart.y, dragCurrent.y);
      const w = Math.abs(dragCurrent.x - dragStart.x);
      const h = Math.abs(dragCurrent.y - dragStart.y);
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#8b5cf6';
      ctx.fillStyle = 'rgba(139,92,246,0.15)';
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
    }

    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);

  // Text for a seat's state; while it is held occupied by the grace period it says how long is left.
  function statusText(zone) {
    if (zone.status === 'grace' && zone.lastSeenAt && GRACE_MS > 0) {
      const mins = Math.ceil(Math.max(0, GRACE_MS - (Date.now() - zone.lastSeenAt)) / 60000);
      return 'Ocupado · ausente (libera en ' + mins + ' min)';
    }
    return STATUS_LABELS[zone.status || 'free'];
  }

  const PUBLIC_LABELS = { busy: 'Ocupado', grace: 'Ausente temporal', away: 'Ausente temporal', free: 'Libre' };

  function groupZones() {
    const groups = [];
    zones.forEach((z) => {
      const key = z.group || '';
      let g = groups.find((x) => x.key === key);
      if (!g) {
        g = { key, name: key || 'Sin grupo', zones: [] };
        groups.push(g);
      }
      g.zones.push(z);
    });
    return groups;
  }

  // ---------- Group manager (admin) ----------
  function allGroupNames() {
    return [...new Set([...customGroups, ...zones.map((z) => z.group).filter(Boolean)])];
  }

  function defaultZoneHint() {
    return activeGroup
      ? 'Grupo activo: ' + activeGroup + '. Pulsa "+ Marcar puesto" y dibuja un puesto sobre el video.'
      : 'Crea un grupo (o elige uno) y luego dibuja sus puestos sobre el video.';
  }

  function renderGroupBar() {
    groupChipsEl.innerHTML = '';
    allGroupNames().forEach((name) => {
      const count = zones.filter((z) => z.group === name).length;
      const chip = document.createElement('span');
      chip.className = 'chip' + (activeGroup === name ? ' active' : '');

      const pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'chip-pick';
      pick.append(document.createTextNode(name + ' '));
      const small = document.createElement('small');
      small.textContent = count + (count === 1 ? ' puesto' : ' puestos');
      pick.appendChild(small);
      pick.addEventListener('click', () => {
        activeGroup = name;
        zoneHint.textContent = defaultZoneHint();
        renderGroupBar();
      });

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'chip-del';
      del.textContent = '✕';
      del.title = 'Eliminar el grupo';
      del.addEventListener('click', () => deleteGroup(name));

      chip.append(pick, del);
      groupChipsEl.appendChild(chip);
    });
  }

  function addGroup() {
    const name = newGroupInput.value.trim();
    if (!name) {
      newGroupInput.focus();
      return;
    }
    if (!allGroupNames().includes(name)) {
      customGroups.push(name);
      saveGroups();
    }
    activeGroup = name;
    newGroupInput.value = '';
    zoneHint.textContent = defaultZoneHint();
    renderGroupBar();
  }

  function renameGroup(oldKey, rawName) {
    const newKey = rawName.trim();
    if (newKey === oldKey) return;
    zones.forEach((z) => {
      if ((z.group || '') === oldKey) z.group = newKey;
    });
    customGroups = [...new Set(customGroups.map((g) => (g === oldKey ? newKey : g)).filter(Boolean))];
    if (activeGroup === oldKey) activeGroup = newKey;
    saveZones();
    saveGroups();
    zoneHint.textContent = defaultZoneHint();
    renderGroupBar();
    setTimeout(renderTableList, 0);
  }

  function deleteGroup(key) {
    const label = key || 'Sin grupo';
    const seats = zones.filter((z) => (z.group || '') === key);
    if (seats.length) {
      if (
        confirm(
          '¿Eliminar el grupo "' + label + '" junto con sus ' + seats.length + ' puestos?\n\n' +
            'Aceptar: se borran el grupo y sus puestos.\nCancelar: te pregunto si prefieres conservar los puestos.'
        )
      ) {
        zones = zones.filter((z) => (z.group || '') !== key);
      } else if (confirm('¿Solo quitar el grupo y dejar sus ' + seats.length + ' puestos como "Sin grupo"?')) {
        seats.forEach((z) => {
          z.group = '';
        });
      } else {
        return;
      }
    } else if (!confirm('¿Eliminar el grupo "' + label + '"?')) {
      return;
    }
    customGroups = customGroups.filter((g) => g !== key);
    if (activeGroup === key) activeGroup = '';
    saveZones();
    saveGroups();
    zoneHint.textContent = defaultZoneHint();
    renderGroupBar();
    renderTableList();
  }

  // Sensitivity slider: higher sensitivity means a lower confidence threshold for "person".
  const sensitivityEl = document.getElementById('sensitivity');
  const sensitivityValueEl = document.getElementById('sensitivityValue');

  function showSensitivity() {
    sensitivityEl.value = Math.round((1 - personMinScore) * 100);
    sensitivityValueEl.textContent = sensitivityEl.value + ' %';
  }

  sensitivityEl.addEventListener('input', () => {
    personMinScore = (100 - Number(sensitivityEl.value)) / 100;
    sensitivityValueEl.textContent = sensitivityEl.value + ' %';
    try {
      localStorage.setItem(SENSITIVITY_KEY, String(personMinScore));
    } catch {
      // storage unavailable: the setting lasts until reload
    }
  });
  showSensitivity();

  // Grace period slider (minutes).
  const graceRangeEl = document.getElementById('graceRange');
  const graceValueEl = document.getElementById('graceValue');
  graceRangeEl.value = Math.min(15, Math.round(graceMinutes));
  graceValueEl.textContent = graceRangeEl.value + ' min';
  graceRangeEl.addEventListener('input', () => {
    graceMinutes = Number(graceRangeEl.value);
    GRACE_MS = graceMinutes * 60 * 1000;
    graceValueEl.textContent = graceMinutes + ' min';
    try {
      localStorage.setItem(GRACE_KEY, String(graceMinutes));
    } catch {
      // storage unavailable: the setting lasts until reload
    }
    lastRenderSignature = '';
  });

  // Model choice: automatic (default), fast or precise. Changing it reloads the model.
  const modelChoiceEl = document.getElementById('modelChoice');
  modelChoiceEl.value = modelPref;
  modelChoiceEl.addEventListener('change', async () => {
    modelPref = modelChoiceEl.value;
    try {
      localStorage.setItem(MODEL_PREF_KEY, modelPref);
    } catch {
      // storage unavailable: the choice lasts until reload
    }
    await loadModel();
  });

  addGroupBtn.addEventListener('click', addGroup);
  newGroupInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addGroup();
  });

  function commitOnEnter(input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
    });
  }

  function buildZoneRow(zone) {
    const li = document.createElement('li');
    li.className = 'table-row' + (zone.status === 'away' || zone.status === 'grace' ? ' away' : zone.occupied ? ' busy' : '');

    const dot = document.createElement('span');
    dot.className = 'dot';

    const nameInput = document.createElement('input');
    nameInput.className = 'name';
    nameInput.value = zone.name;
    nameInput.addEventListener('change', () => {
      zone.name = nameInput.value.trim() || zone.name;
      saveZones();
      setTimeout(renderTableList, 0);
    });
    commitOnEnter(nameInput);

    const groupField = document.createElement('input');
    groupField.className = 'group';
    groupField.setAttribute('list', 'groupList');
    groupField.placeholder = 'Grupo';
    groupField.value = zone.group || '';
    groupField.addEventListener('change', () => {
      zone.group = groupField.value.trim();
      saveZones();
      setTimeout(renderTableList, 0);
    });
    commitOnEnter(groupField);

    const state = document.createElement('span');
    state.className = 'state';
    state.textContent = statusText(zone);

    // A seat held by the grace period (or by belongings) can be freed by hand, e.g. when someone moved seats.
    let release = null;
    if (zone.status === 'grace' || zone.status === 'away') {
      release = document.createElement('button');
      release.className = 'release';
      release.textContent = 'Liberar';
      release.title = 'Marcar este puesto como libre ahora';
      release.addEventListener('click', () => releaseZone(zone));
    }

    const remove = document.createElement('button');
    remove.className = 'remove';
    remove.textContent = '✕';
    remove.addEventListener('click', () => {
      zones = zones.filter((z) => z.id !== zone.id);
      saveZones();
      renderTableList();
    });

    li.append(dot, nameInput, groupField, state);
    if (release) li.appendChild(release);
    li.appendChild(remove);
    return li;
  }

  function releaseZone(zone) {
    zone.occupied = false;
    zone.status = 'free';
    zone.lastSeenAt = null;
    zone.occupiedSince = null;
    zone.history = [];
    lastRenderSignature = '';
    renderTableList();
  }

  function renderTableList() {
    tableCountEl.textContent = '(' + zones.length + ')';
    const busy = zones.filter((z) => z.occupied).length;
    freeCountEl.textContent = zones.length - busy;
    busyCountEl.textContent = busy;
    broadcastLive();

    if (!isAdmin()) {
      renderPublic();
      return;
    }

    renderGroupBar();

    // Do not wipe an input the admin is typing in; the list refreshes on the next cycle after it loses focus.
    const active = document.activeElement;
    if (active && active.tagName === 'INPUT' && tableList.contains(active)) return;

    groupListEl.innerHTML = '';
    allGroupNames().forEach((g) => {
      const opt = document.createElement('option');
      opt.value = g;
      groupListEl.appendChild(opt);
    });

    tableList.innerHTML = '';
    if (!zones.length) {
      const li = document.createElement('li');
      li.className = 'empty-list';
      li.textContent = 'Aún no has marcado ningún puesto. Crea un grupo y dibuja sus puestos sobre el video.';
      tableList.appendChild(li);
      return;
    }

    groupZones().forEach((g) => {
      const free = g.zones.filter((z) => !z.occupied).length;
      const header = document.createElement('li');
      header.className = 'group-header' + (free === 0 ? ' full' : '');

      const title = document.createElement('input');
      title.className = 'group-name';
      title.value = g.key;
      title.placeholder = 'Sin grupo';
      title.title = 'Cambia el nombre del grupo';
      title.addEventListener('change', () => renameGroup(g.key, title.value));
      commitOnEnter(title);

      const count = document.createElement('span');
      count.className = 'group-count';
      count.textContent = free + ' de ' + g.zones.length + ' libres';

      const del = document.createElement('button');
      del.className = 'group-del';
      del.textContent = '✕';
      del.title = 'Eliminar el grupo';
      del.addEventListener('click', () => deleteGroup(g.key));

      header.append(title, count, del);
      tableList.appendChild(header);
      g.zones.forEach((zone) => tableList.appendChild(buildZoneRow(zone)));
    });
  }

  function renderPublic() {
    renderOpenStatus();
    const total = zones.length;
    const free = zones.filter((z) => !z.occupied).length;
    const pct = total ? Math.round((free / total) * 100) : 0;
    const low = total > 0 && pct < 25;

    pubFreeEl.textContent = free;
    pubTotalEl.textContent = total;
    pubLabelEl.textContent = total === 0 ? 'esperando datos del monitoreo' : free === 1 ? 'puesto disponible' : 'puestos disponibles';
    pubBarEl.style.width = pct + '%';
    pubBarEl.classList.toggle('low', low);
    pubFreeEl.parentElement.classList.toggle('low', low);

    pubGroupsEl.innerHTML = '';
    if (!total) {
      const empty = document.createElement('div');
      empty.className = 'pv-empty';
      empty.textContent = viewerLastMsg
        ? 'Aún no hay mesas configuradas.'
        : 'La información en vivo no está disponible en este momento. Inténtalo de nuevo en unos minutos.';
      pubGroupsEl.appendChild(empty);
      return;
    }

    groupZones().forEach((g) => {
      const groupFree = g.zones.filter((z) => !z.occupied).length;
      const card = document.createElement('article');
      card.className = 'pv-card';

      const head = document.createElement('div');
      head.className = 'pv-card-head';
      const title = document.createElement('h3');
      title.textContent = g.name;
      const badge = document.createElement('span');
      badge.className = 'pv-badge' + (groupFree === 0 ? ' full' : '');
      badge.textContent = groupFree === 0 ? 'Completo' : groupFree + ' de ' + g.zones.length + ' libres';
      head.append(title, badge);

      const seats = document.createElement('div');
      seats.className = 'pv-seats';
      g.zones.forEach((z) => {
        // A seat whose person stepped away for a moment (grace period) or left belongings shows as "away", not "busy".
        const status = z.status === 'away' || z.status === 'grace' ? 'away' : z.occupied ? 'busy' : 'free';
        const seat = document.createElement('span');
        seat.className = 'pv-seat ' + status;
        seat.title = PUBLIC_LABELS[z.status || 'free'];
        const dot = document.createElement('i');
        dot.className = 'dot ' + status;
        seat.append(dot, document.createTextNode(z.name));
        seats.appendChild(seat);
      });

      card.append(head, seats);
      pubGroupsEl.appendChild(card);
    });
  }

  // Public visitors never trigger the camera or the model; only an admin session does.
  applyRole();
})();

// Phone side: capture the camera and send it to the PC that showed the QR.
function runSender(targetId) {
  document.body.classList.add('sender-mode');
  const view = document.getElementById('senderView');
  const preview = document.getElementById('senderPreview');
  const status = document.getElementById('senderStatus');
  const retryBtn = document.getElementById('senderRetry');
  view.hidden = false;

  let stream = null;
  let peer = null;
  let reconnectTimer = null;

  async function start() {
    retryBtn.hidden = true;
    try {
      if (!stream) {
        status.textContent = 'Solicitando acceso a la cámara…';
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        preview.srcObject = stream;
      }
      try {
        if (navigator.wakeLock) await navigator.wakeLock.request('screen');
      } catch {
        // wake lock is best-effort
      }
      connect();
    } catch (err) {
      status.textContent = 'No se pudo acceder a la cámara: ' + err.message;
      retryBtn.hidden = false;
    }
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 3000);
  }

  function connect() {
    if (peer) peer.destroy();
    status.textContent = 'Conectando con el PC…';
    peer = new Peer();

    peer.on('open', () => {
      const call = peer.call(targetId, stream);
      const pc = call.peerConnection;
      if (pc) {
        pc.addEventListener('connectionstatechange', () => {
          if (pc.connectionState === 'connected') {
            status.textContent = 'Transmitiendo al PC ✓';
          } else if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
            status.textContent = 'Conexión perdida. Reintentando…';
            scheduleReconnect();
          }
        });
      }
      call.on('close', () => {
        status.textContent = 'Conexión cerrada. Reintentando…';
        scheduleReconnect();
      });
    });

    peer.on('error', (err) => {
      if (err.type === 'peer-unavailable') {
        status.textContent = 'El PC no está esperando. En el PC elige "Cámara de celular (QR)" y escanea el código nuevo.';
        retryBtn.hidden = false;
      } else {
        status.textContent = 'Error de conexión (' + err.type + '). Reintentando…';
        scheduleReconnect();
      }
    });
  }

  retryBtn.addEventListener('click', start);

  // Landscape lock only works in fullscreen on Android Chrome; elsewhere the user just rotates the phone.
  document.getElementById('senderLandscape').addEventListener('click', async () => {
    try {
      await document.documentElement.requestFullscreen();
      await screen.orientation.lock('landscape');
    } catch {
      status.textContent = 'No se pudo forzar horizontal. Gira el celular manualmente.';
    }
  });

  start();
}
