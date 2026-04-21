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
let hostWidth = 1920;
let hostHeight = 1080;

// FPS tracking
let frameCount = 0;
let lastFpsTime = performance.now();

// Frame decode queue — only keep latest frame, drop stale ones
let pendingFrame = null;
let renderScheduled = false;

hostInput.value = localStorage.getItem('rd_host') || '';
secretInput.value = localStorage.getItem('rd_secret') || '';

connectBtn.addEventListener('click', connect);
disconnectBtn.addEventListener('click', disconnect);
hostInput.addEventListener('keydown', e => { if (e.key === 'Enter') connect(); });
secretInput.addEventListener('keydown', e => { if (e.key === 'Enter') connect(); });

function connect() {
  const host = hostInput.value.trim();
  const secret = secretInput.value.trim();
  if (!host) { setStatus('Enter a host address'); return; }
  if (!secret) { setStatus('Enter your secret'); return; }

  localStorage.setItem('rd_host', host);
  localStorage.setItem('rd_secret', secret);

  setStatus('Connecting...');
  connectBtn.disabled = true;

  const url = `${host}?secret=${encodeURIComponent(secret)}&ngrok-skip-browser-warning=true`;
  ws = new WebSocket(url);
  ws.binaryType = 'blob'; // receive frames as Blob

  ws.onopen = () => {
    setStatus('');
    // Set default canvas size before info message arrives
    canvas.width = hostWidth;
    canvas.height = hostHeight;
    connectScreen.style.display = 'none';
    remoteScreen.style.display = 'flex';
    connDot.classList.remove('disconnected');
    connLabel.textContent = 'Connected';
    attachInputListeners();
  };

  ws.onmessage = (e) => {
    if (typeof e.data === 'string') {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'info') {
          hostWidth = msg.width;
          hostHeight = msg.height;
          canvas.width = hostWidth;
          canvas.height = hostHeight;
          connLabel.textContent = `Connected (${hostWidth}x${hostHeight})`;
          console.log('Got info:', hostWidth, hostHeight);
        } else if (msg.type === 'frame') {
          pendingFrame = msg.data;
          if (!renderScheduled) {
            renderScheduled = true;
            requestAnimationFrame(renderPending);
          }
        } else if (msg.type === 'error') {
          setStatus(msg.message || 'Error');
          disconnect();
        }
      } catch (_) {}
    }
  };

  ws.onerror = () => {
    setStatus('Connection failed. Check host address and secret.');
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
    detachInputListeners();
  };
}

function disconnect() {
  if (ws) ws.close();
  remoteScreen.style.display = 'none';
  connectScreen.style.display = 'flex';
}

// Render the latest pending frame
function renderPending() {
  renderScheduled = false;
  if (!pendingFrame) return;

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
  img.onerror = (err) => console.error('Frame decode error:', err);
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

// ---- Input Handling ----

function getCanvasPos(e) {
  const rect = canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) * (hostWidth / rect.width);
  const y = (e.clientY - rect.top) * (hostHeight / rect.height);
  return { x: Math.round(x), y: Math.round(y) };
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
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

function onMouseDown(e) {
  e.preventDefault();
  cursor.classList.add('clicking');
  send({ type: 'mousedown', button: e.button, ...getCanvasPos(e) });
}

function onMouseUp(e) {
  e.preventDefault();
  cursor.classList.remove('clicking');
  send({ type: 'mouseup', button: e.button, ...getCanvasPos(e) });
}

function onDblClick(e) {
  e.preventDefault();
  send({ type: 'dblclick', ...getCanvasPos(e) });
}

function onContextMenu(e) { e.preventDefault(); }

function onWheel(e) {
  e.preventDefault();
  send({ type: 'scroll', deltaX: e.deltaX, deltaY: e.deltaY });
}

const pressedKeys = new Set();

function onKeyDown(e) {
  e.preventDefault();
  if (pressedKeys.has(e.key)) return;
  pressedKeys.add(e.key);
  if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
    send({ type: 'type', text: e.key });
  } else {
    send({ type: 'keydown', key: e.key, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey });
  }
}

function onKeyUp(e) {
  e.preventDefault();
  pressedKeys.delete(e.key);
  if (e.key.length > 1 || e.ctrlKey || e.altKey || e.metaKey) {
    send({ type: 'keyup', key: e.key });
  }
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
