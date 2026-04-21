const connectScreen = document.getElementById('connect-screen');
const remoteScreen = document.getElementById('remote-screen');
const hostInput = document.getElementById('host-input');
const secretInput = document.getElementById('secret-input');
const connectBtn = document.getElementById('connect-btn');
const statusMsg = document.getElementById('status-msg');
const canvas = document.getElementById('screen-canvas');
const ctx = canvas.getContext('2d');
const connDot = document.getElementById('conn-dot');
const connLabel = document.getElementById('conn-label');
const fpsDisplay = document.getElementById('fps-display');
const disconnectBtn = document.getElementById('disconnect-btn');
const cursor = document.getElementById('custom-cursor');
const canvasContainer = document.getElementById('canvas-container');

let ws = null;
let pc = null; // WebRTC peer connection
let hostWidth = 1920;
let hostHeight = 1080;
let usingWebRTC = false;

// FPS tracking
let frameCount = 0;
let lastFpsTime = performance.now();
let pendingFrame = null;
let renderScheduled = false;

// Build full WSS URL from tunnel ID input
function buildHost() {
  const val = hostInput.value.trim();
  if (!val) return '';
  // If already a full URL, use as-is
  if (val.startsWith('ws')) return val;
  // Strip any accidental domain parts the user might paste
  const id = val.replace(/\.trycloudflare\.com.*$/, '').replace(/^wss?:\/\//, '');
  return `wss://${id}.trycloudflare.com`;
}

// Load saved settings — store only the tunnel ID
const savedHost = localStorage.getItem('rd_host') || '';
hostInput.value = savedHost.replace(/^wss?:\/\//, '').replace(/\.trycloudflare\.com.*$/, '');
secretInput.value = localStorage.getItem('rd_secret') || 'fr0gz123';

// Auto-connect if saved
if (hostInput.value && secretInput.value) setTimeout(connect, 500);

connectBtn.addEventListener('click', connect);
disconnectBtn.addEventListener('click', disconnect);
document.getElementById('fullscreen-btn').addEventListener('click', () => {
  const el = canvasContainer;
  if (!document.fullscreenElement) el.requestFullscreen().catch(() => {});
  else document.exitFullscreen();
});
document.getElementById('forget-btn').addEventListener('click', () => {
  localStorage.removeItem('rd_host');
  localStorage.removeItem('rd_secret');
  hostInput.value = '';
  secretInput.value = 'fr0gz123';
  setStatus('Saved address cleared.');
});
hostInput.addEventListener('keydown', e => { if (e.key === 'Enter') connect(); });
secretInput.addEventListener('keydown', e => { if (e.key === 'Enter') connect(); });
hostInput.addEventListener('paste', () => setTimeout(connect, 150));

function connect() {
  const host = buildHost();
  const secret = secretInput.value.trim();
  if (!host) { setStatus('Enter your tunnel ID'); return; }
  if (!secret) { setStatus('Enter your secret'); return; }

  localStorage.setItem('rd_host', host);
  localStorage.setItem('rd_secret', secret);

  setStatus('Connecting...');
  connectBtn.disabled = true;

  const url = `${host}?secret=${encodeURIComponent(secret)}&ngrok-skip-browser-warning=true`;
  ws = new WebSocket(url);

  ws.onopen = () => {
    setStatus('');
    canvas.width = hostWidth;
    canvas.height = hostHeight;
    connectScreen.style.display = 'none';
    remoteScreen.style.display = 'flex';
    connDot.classList.remove('disconnected');
    connLabel.textContent = 'Connected';
    attachInputListeners();
    // Try to upgrade to WebRTC
    initWebRTC();
  };

  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') return;
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'info') {
        hostWidth = msg.width;
        hostHeight = msg.height;
        canvas._screenWidth = msg.screenWidth || msg.width;
        canvas._screenHeight = msg.screenHeight || msg.height;
        canvas.width = hostWidth;
        canvas.height = hostHeight;
        connLabel.textContent = `Connected (${hostWidth}x${hostHeight})`;
      } else if (msg.type === 'frame' && !usingWebRTC) {
        // Fallback JPEG stream
        pendingFrame = msg.data;
        if (!renderScheduled) {
          renderScheduled = true;
          requestAnimationFrame(renderPending);
        }
      } else if (msg.type === 'rtc-answer') {
        if (pc) pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      } else if (msg.type === 'rtc-ice') {
        if (pc) pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(() => {});
      } else if (msg.type === 'rtc-unavailable') {
        // Host doesn't support WebRTC, stay on JPEG stream
        usingWebRTC = false;
        connLabel.textContent += ' (JPEG)';
      } else if (msg.type === 'error') {
        setStatus(msg.message || 'Error');
        disconnect();
      }
    } catch (_) {}
  };

  ws.onerror = () => {
    setStatus('Connection failed. Check tunnel ID and secret.');
    connectBtn.disabled = false;
    ws = null;
  };

  ws.onclose = () => {
    connectBtn.disabled = false;
    if (remoteScreen.style.display === 'flex') {
      connDot.classList.add('disconnected');
      connLabel.textContent = 'Disconnected';
    } else {
      setStatus('Connection closed.');
    }
    ws = null;
    if (pc) { pc.close(); pc = null; }
    usingWebRTC = false;
    detachInputListeners();
  };
}

// ---- WebRTC ----
async function initWebRTC() {
  try {
    pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    });

    // Receive video track
    pc.ontrack = (e) => {
      if (e.track.kind !== 'video') return;
      const stream = e.streams[0];
      // Render WebRTC stream to canvas via hidden video element
      let vid = document.getElementById('rtc-video');
      if (!vid) {
        vid = document.createElement('video');
        vid.id = 'rtc-video';
        vid.autoplay = true;
        vid.playsInline = true;
        vid.muted = true;
        vid.style.display = 'none';
        document.body.appendChild(vid);
      }
      vid.srcObject = stream;
      vid.onloadedmetadata = () => {
        usingWebRTC = true;
        connLabel.textContent = connLabel.textContent.replace(' (JPEG)', '') + ' (WebRTC)';
        renderWebRTC(vid);
      };
    };

    pc.onicecandidate = (e) => {
      if (e.candidate && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'rtc-ice', candidate: e.candidate }));
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc && (pc.connectionState === 'failed' || pc.connectionState === 'disconnected')) {
        usingWebRTC = false;
        connLabel.textContent = connLabel.textContent.replace(' (WebRTC)', ' (JPEG)');
      }
    };

    // Add transceiver to receive video
    pc.addTransceiver('video', { direction: 'recvonly' });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'rtc-offer', sdp: pc.localDescription }));
    }
  } catch (e) {
    console.warn('WebRTC init failed, using JPEG fallback:', e.message);
    usingWebRTC = false;
  }
}

function renderWebRTC(vid) {
  if (!usingWebRTC) return;
  if (vid.readyState >= 2) {
    ctx.drawImage(vid, 0, 0, canvas.width, canvas.height);
    trackFps();
  }
  requestAnimationFrame(() => renderWebRTC(vid));
}

// ---- JPEG fallback renderer ----
function renderPending() {
  renderScheduled = false;
  if (!pendingFrame || usingWebRTC) return;
  const b64 = pendingFrame;
  pendingFrame = null;
  const img = new Image();
  img.onload = () => {
    ctx.drawImage(img, 0, 0);
    trackFps();
    if (pendingFrame && !renderScheduled) {
      renderScheduled = true;
      requestAnimationFrame(renderPending);
    }
  };
  img.src = 'data:image/jpeg;base64,' + b64;
}

function trackFps() {
  frameCount++;
  const now = performance.now();
  if (now - lastFpsTime >= 1000) {
    fpsDisplay.textContent = `${frameCount} fps`;
    frameCount = 0;
    lastFpsTime = now;
  }
}

function disconnect() {
  if (ws) ws.close();
  if (pc) { pc.close(); pc = null; }
  usingWebRTC = false;
  remoteScreen.style.display = 'none';
  connectScreen.style.display = 'flex';
}

// ---- Input ----
function getCanvasPos(e) {
  const rect = canvas.getBoundingClientRect();
  const sw = canvas._screenWidth || hostWidth;
  const sh = canvas._screenHeight || hostHeight;
  return {
    x: Math.round((e.clientX - rect.left) / rect.width * sw),
    y: Math.round((e.clientY - rect.top) / rect.height * sh)
  };
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 65536) {
    ws.send(JSON.stringify(obj));
  }
}

let lastMouseMove = 0;
function onMouseMove(e) {
  const now = performance.now();
  if (now - lastMouseMove < 16) return;
  lastMouseMove = now;
  cursor.style.left = e.clientX + 'px';
  cursor.style.top = e.clientY + 'px';
  send({ type: 'mousemove', ...getCanvasPos(e) });
}
function onMouseDown(e) { e.preventDefault(); cursor.classList.add('clicking'); send({ type: 'mousedown', button: e.button, ...getCanvasPos(e) }); }
function onMouseUp(e) { e.preventDefault(); cursor.classList.remove('clicking'); send({ type: 'mouseup', button: e.button, ...getCanvasPos(e) }); }
function onDblClick(e) { e.preventDefault(); send({ type: 'dblclick', ...getCanvasPos(e) }); }
function onContextMenu(e) { e.preventDefault(); }
function onWheel(e) { e.preventDefault(); send({ type: 'scroll', deltaX: e.deltaX, deltaY: e.deltaY }); }

const pressedKeys = new Set();
function onKeyDown(e) {
  e.preventDefault();
  if (pressedKeys.has(e.key)) return;
  pressedKeys.add(e.key);
  if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) send({ type: 'type', text: e.key });
  else send({ type: 'keydown', key: e.key, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey });
}
function onKeyUp(e) {
  e.preventDefault();
  pressedKeys.delete(e.key);
  if (e.key.length > 1 || e.ctrlKey || e.altKey || e.metaKey) send({ type: 'keyup', key: e.key });
}

function attachInputListeners() {
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('mouseup', onMouseUp);
  canvas.addEventListener('dblclick', onDblClick);
  canvas.addEventListener('contextmenu', onContextMenu);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
}
function detachInputListeners() {
  canvas.removeEventListener('mousemove', onMouseMove);
  canvas.removeEventListener('mousedown', onMouseDown);
  canvas.removeEventListener('mouseup', onMouseUp);
  canvas.removeEventListener('dblclick', onDblClick);
  canvas.removeEventListener('contextmenu', onContextMenu);
  canvas.removeEventListener('wheel', onWheel);
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('keyup', onKeyUp);
}

function setStatus(msg) { statusMsg.textContent = msg; }

canvasContainer.addEventListener('mousemove', (e) => {
  cursor.style.left = e.clientX + 'px';
  cursor.style.top = e.clientY + 'px';
});
