(function () {
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

  const STORAGE_KEY = 'spaceiq.tables.v1';

  let model = null;
  let activeMedia = null; // 'video' | 'img' | null
  let detecting = false;
  let detectionTimer = null;
  let zones = loadZones();
  let latestPersons = []; // fractional boxes, for on-screen debug only
  let isDrawingZone = false;
  let dragStart = null;
  let dragCurrent = null;
  let zoneCounter = zones.reduce((max, z) => Math.max(max, z.n || 0), 0);
  let webcamStream = null;

  function loadZones() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  function saveZones() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(zones));
  }

  // ---------- Model ----------
  async function loadModel() {
    try {
      model = await cocoSsd.load();
      modelStatus.textContent = 'Modelo listo';
      modelStatus.classList.add('ready');
      updateToggleAvailability();
    } catch (err) {
      modelStatus.textContent = 'Error cargando el modelo';
      modelStatus.classList.add('error');
      console.error(err);
    }
  }
  loadModel();

  // ---------- Media source ----------
  sourceRadios.forEach((r) => r.addEventListener('change', onSourceChange));

  function onSourceChange(e) {
    stopDetection();
    if (e.target.value === 'webcam') {
      ipcamUrlWrap.hidden = true;
      stopIpcam();
      startWebcam();
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
      stageEmpty.textContent = 'No se pudo acceder a la cámara del dispositivo: ' + err.message;
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

  connectIpcamBtn.addEventListener('click', () => {
    const url = ipcamUrlInput.value.trim();
    if (!url) return;
    stopDetection();
    stopWebcam();
    video.hidden = true;
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      stageEmpty.hidden = true;
      activeMedia = 'img';
      updateToggleAvailability();
    };
    img.onerror = () => {
      stageEmpty.hidden = false;
      stageEmpty.textContent =
        'No se pudo cargar el stream. Verifica la URL y que la cámara permita acceso desde el navegador (CORS).';
      activeMedia = null;
      updateToggleAvailability();
    };
    img.src = url;
    img.hidden = false;
  });

  function stopIpcam() {
    img.src = '';
    img.hidden = true;
  }

  function updateToggleAvailability() {
    toggleDetectionBtn.disabled = !(model && activeMedia);
  }

  // ---------- Detection ----------
  toggleDetectionBtn.addEventListener('click', () => {
    if (detecting) stopDetection();
    else startDetection();
  });

  function startDetection() {
    if (!model || !activeMedia) return;
    detecting = true;
    toggleDetectionBtn.textContent = 'Detener detección';
    detectionTimer = setInterval(runDetection, 700);
    runDetection();
  }

  function stopDetection() {
    detecting = false;
    toggleDetectionBtn.textContent = 'Iniciar detección';
    if (detectionTimer) clearInterval(detectionTimer);
    detectionTimer = null;
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
    const mediaEl = getMediaEl();
    const size = getNaturalSize();
    if (!mediaEl || !size || !size.width || !size.height) return;

    let predictions;
    try {
      predictions = await model.detect(mediaEl);
    } catch (err) {
      console.error('Detection error', err);
      stopDetection();
      modelStatus.textContent = 'Error de detección (¿CORS del stream?)';
      modelStatus.classList.add('error');
      return;
    }

    latestPersons = predictions
      .filter((p) => p.class === 'person' && p.score > 0.5)
      .map((p) => ({
        x: p.bbox[0] / size.width,
        y: p.bbox[1] / size.height,
        w: p.bbox[2] / size.width,
        h: p.bbox[3] / size.height,
      }));

    zones.forEach((zone) => {
      zone.occupied = latestPersons.some((p) => overlapRatio(p, zone) > 0.12);
    });
    renderTableList();
  }

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
    zoneHint.textContent = 'Arrastra sobre el video para dibujar el área de la nueva mesa (o toca un punto para una mesa de tamaño estándar).';
  });

  clearZonesBtn.addEventListener('click', () => {
    if (zones.length && confirm('¿Borrar todas las mesas marcadas?')) {
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
        name: 'Mesa ' + zoneCounter,
        x: fx,
        y: fy,
        w: fw,
        h: fh,
        occupied: false,
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
    zoneHint.textContent = 'Arrastra sobre el video para dibujar el área de una mesa.';
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
      ctx.strokeStyle = zone.occupied ? '#ef4444' : '#22c55e';
      ctx.fillStyle = zone.occupied ? 'rgba(239,68,68,0.15)' : 'rgba(34,197,94,0.12)';
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);

      const label = zone.name + (zone.occupied ? ' · ocupada' : ' · vacía');
      ctx.font = '13px Inter, sans-serif';
      const labelWidth = ctx.measureText(label).width + 10;
      ctx.fillStyle = zone.occupied ? '#ef4444' : '#22c55e';
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
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = 'rgba(59,130,246,0.9)';
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(x, y, w, h);
        ctx.setLineDash([]);
      });
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

  function renderTableList() {
    tableCountEl.textContent = '(' + zones.length + ')';
    const busy = zones.filter((z) => z.occupied).length;
    freeCountEl.textContent = zones.length - busy;
    busyCountEl.textContent = busy;

    tableList.innerHTML = '';
    if (!zones.length) {
      const li = document.createElement('li');
      li.className = 'empty-list';
      li.textContent = 'Aún no has marcado ninguna mesa.';
      tableList.appendChild(li);
      return;
    }

    zones.forEach((zone) => {
      const li = document.createElement('li');
      li.className = 'table-row' + (zone.occupied ? ' busy' : '');

      const dot = document.createElement('span');
      dot.className = 'dot';

      const nameInput = document.createElement('input');
      nameInput.className = 'name';
      nameInput.value = zone.name;
      nameInput.addEventListener('change', () => {
        zone.name = nameInput.value.trim() || zone.name;
        saveZones();
      });

      const state = document.createElement('span');
      state.className = 'state';
      state.textContent = zone.occupied ? 'Ocupada' : 'Vacía';

      const remove = document.createElement('button');
      remove.className = 'remove';
      remove.textContent = '✕';
      remove.addEventListener('click', () => {
        zones = zones.filter((z) => z.id !== zone.id);
        saveZones();
        renderTableList();
      });

      li.append(dot, nameInput, state, remove);
      tableList.appendChild(li);
    });
  }

  renderTableList();

  // Default to webcam on load
  startWebcam();
})();
