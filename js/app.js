import { Gimbal } from "./gimbal.js";
import { DetectorTracker, RegionTracker } from "./tracker.js";
import { hex } from "./duml.js";

const $ = (id) => document.getElementById(id);
const gimbal = new Gimbal();

// ---------------------------------------------------------------------
//  Ajustes (se guardan en el navegador)
// ---------------------------------------------------------------------
const SETTINGS = ["manSpeed", "kp", "smooth", "trackMax", "dead", "frameY", "invYaw", "invPitch", "trackPitch",
  "chkMirror", "namePrefix", "uuidSvc", "uuidNotify", "uuidWrite", "addrSender", "addrReceiver", "objClass"];
function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem("osmo-control") || "{}"); } catch {}
  for (const k of SETTINGS) {
    const el = $(k); if (!el || s[k] === undefined) continue;
    if (el.type === "checkbox") el.checked = s[k]; else el.value = s[k];
  }
}
function saveSettings() {
  const s = {};
  for (const k of SETTINGS) { const el = $(k); if (el) s[k] = el.type === "checkbox" ? el.checked : el.value; }
  try { localStorage.setItem("osmo-control", JSON.stringify(s)); } catch {}
}
const num = (id) => parseFloat($(id).value);
const on = (id) => $(id).checked;

function bindOutputs() {
  const fmt = { manSpeed: (v) => `${v}°/s`, trackMax: (v) => `${v}°/s` };
  for (const id of ["manSpeed", "kp", "smooth", "trackMax", "dead", "frameY"]) {
    const upd = () => ($(id + "Out").textContent = (fmt[id] || ((v) => v))($(id).value));
    $(id).addEventListener("input", () => { upd(); saveSettings(); });
    upd();
  }
  for (const k of SETTINGS) $(k)?.addEventListener("change", saveSettings);
}

// ---------------------------------------------------------------------
//  Log
// ---------------------------------------------------------------------
const logEl = $("log");
function log(msg) {
  const t = new Date().toLocaleTimeString();
  logEl.textContent = `[${t}] ${msg}\n` + logEl.textContent.slice(0, 20000);
}

// ---------------------------------------------------------------------
//  Bluetooth
// ---------------------------------------------------------------------
function setStatus(state, text) {
  $("statusDot").className = "dot " + (state === "on" ? "on" : state === "busy" ? "busy" : "");
  $("statusText").textContent = text;
  $("btnConnect").classList.toggle("hidden", state === "on");
  $("btnDisconnect").classList.toggle("hidden", state !== "on");
}

$("btnConnect").onclick = async () => {
  setStatus("busy", "Buscando…");
  gimbal.builder.sender = parseInt($("addrSender").value, 16) || 0x02;
  gimbal.builder.receiver = parseInt($("addrReceiver").value, 16) || 0x04;
  const fullUuid = (s) => (/^[0-9a-f]{4}$/i.test(s.trim()) ? `0000${s.trim().toLowerCase()}-0000-1000-8000-00805f9b34fb` : s.trim());
  try {
    await gimbal.connect({
      namePrefix: $("namePrefix").value.trim(),
      uuids: { service: fullUuid($("uuidSvc").value), notify: fullUuid($("uuidNotify").value), write: fullUuid($("uuidWrite").value) },
    });
  } catch (e) {
    setStatus("off", "Desconectado");
    if (e.name !== "NotFoundError") log("No se pudo conectar: " + (e.message || e));
    else log("Selección cancelada.");
  }
};
$("btnDisconnect").onclick = () => gimbal.disconnect();

gimbal.addEventListener("log", (e) => log(e.detail));
gimbal.addEventListener("connected", (e) => { setStatus("on", e.detail); log("✔ Conectado a " + e.detail); });
gimbal.addEventListener("disconnected", () => { setStatus("off", "Desconectado"); $("att").classList.add("hidden"); log("Gimbal desconectado."); });
gimbal.addEventListener("battery", (e) => { $("batt").classList.remove("hidden"); $("batt").textContent = `🔋 ${e.detail}%`; });
gimbal.addEventListener("attitude", (e) => {
  const a = e.detail; $("att").classList.remove("hidden");
  $("att").textContent = `Y ${a.yaw.toFixed(1)}° · P ${a.pitch.toFixed(1)}° · R ${a.roll.toFixed(1)}°`;
});
gimbal.addEventListener("tx", (e) => log("TX " + e.detail));
gimbal.addEventListener("packet", (e) => {
  if (!on("logRx")) return;
  const m = e.detail;
  log(`RX set=${m.cmdSet.toString(16).padStart(2, "0")} cmd=${m.cmdId.toString(16).padStart(2, "0")} ${m.crcOk ? "" : "(CRC!) "}| ${hex(m.payload)}`);
});
$("logTx").onchange = () => (gimbal.logTx = on("logTx"));
$("btnClearLog").onclick = () => (logEl.textContent = "");

$("btnAbs").onclick = () => {
  const [y, p, r] = $("absAngle").value.split(",").map((v) => parseFloat(v) || 0);
  gimbal.moveTo(y, p, r, 1.5);
};
$("btnRaw").onclick = () => {
  const bytes = $("rawPayload").value.trim().split(/[\s,]+/).filter(Boolean).map((h) => parseInt(h, 16) & 0xff);
  gimbal.sendRaw(parseInt($("rawSet").value, 16), parseInt($("rawCmd").value, 16), bytes);
  log("Enviado paquete manual.");
};

// ---------------------------------------------------------------------
//  Cámara
// ---------------------------------------------------------------------
const video = $("video"), overlay = $("overlay"), octx = overlay.getContext("2d"), wrap = $("videoWrap");
let stream = null;

async function listCams() {
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
    const cur = $("camSelect").value;
    $("camSelect").innerHTML = devs.map((d, i) => `<option value="${d.deviceId}">${d.label || "Cámara " + (i + 1)}</option>`).join("") || "<option value=''>Cámara por defecto</option>";
    if (cur && devs.some((d) => d.deviceId === cur)) $("camSelect").value = cur;
  } catch {}
}
async function startCam() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  const id = $("camSelect").value;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: id ? { exact: id } : undefined, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: false,
    });
  } catch (e) { log("No se pudo abrir la cámara: " + e.message); return; }
  video.srcObject = stream;
  await video.play();
  $("videoHint").classList.add("hidden");
  $("btnCam").textContent = "Cambiar cámara";
  await listCams();
  const tr = stream.getVideoTracks()[0];
  if (tr?.getSettings().deviceId) $("camSelect").value = tr.getSettings().deviceId;
}
video.addEventListener("loadedmetadata", () => {
  wrap.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
  overlay.width = video.videoWidth; overlay.height = video.videoHeight;
});
$("btnCam").onclick = startCam;
$("camSelect").onchange = () => stream && startCam();
$("chkMirror").onchange = () => wrap.classList.toggle("mirror", on("chkMirror"));
listCams();

// ---------------------------------------------------------------------
//  Seguimiento
// ---------------------------------------------------------------------
const trackers = { face: new DetectorTracker("face"), object: new DetectorTracker("object"), region: new RegionTracker() };
let mode = "off";
let locked = false;          // "bloqueo" (mantener el botón Centrar)
let target = null;
let lastTargetTime = 0;

const MODE_NAMES = { off: "apagado", face: "cara", object: "persona/objeto", region: "región" };
const MODE_ORDER = ["off", "face", "object", "region"];

async function setMode(m) {
  mode = m;
  document.querySelectorAll("#modeSeg button").forEach((b) => b.classList.toggle("on", b.dataset.mode === m));
  $("objClass").classList.toggle("hidden", m !== "object");
  Object.values(trackers).forEach((t) => t.reset());
  target = null;
  updateBadge();
  if (m === "face" || m === "object") {
    const t = trackers[m];
    t.lockedClass = m === "object" ? $("objClass").value : null;
    if (!t.task) {
      $("modeBadge").textContent = "Cargando modelo…";
      try { await t.init(); log(`Modelo de ${MODE_NAMES[m]} cargado.`); }
      catch (e) { log("No se pudo cargar el modelo (¿sin internet?): " + (e.message || e)); setMode("region"); return; }
    }
  }
  if (m === "region") log("Arrastrá un rectángulo sobre el video para elegir qué seguir.");
  if (m !== "off" && !stream) log("Iniciá la cámara para usar el seguimiento.");
  updateBadge();
}
document.querySelectorAll("#modeSeg button").forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
$("objClass").onchange = () => { trackers.object.lockedClass = $("objClass").value; trackers.object.reset(); saveSettings(); };

function updateBadge() {
  const b = $("modeBadge");
  b.className = "mode-badge";
  if (locked) { b.textContent = "🔒 Bloqueado"; b.classList.add("lost"); return; }
  if (mode === "off") { b.textContent = "Seguimiento: apagado"; return; }
  if (target) { b.textContent = `Siguiendo ${MODE_NAMES[mode]}`; b.classList.add("active"); }
  else { b.textContent = mode === "region" && !trackers.region.tpl ? "Dibujá un rectángulo" : `Buscando ${MODE_NAMES[mode]}…`; b.classList.add("lost"); }
}

// --- selección sobre el video (click o arrastre) ---
let drag = null;
function normPoint(ev) {
  const r = overlay.getBoundingClientRect();
  let x = (ev.clientX - r.left) / r.width, y = (ev.clientY - r.top) / r.height;
  if (on("chkMirror")) x = 1 - x;
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
}
overlay.addEventListener("pointerdown", (ev) => { overlay.setPointerCapture(ev.pointerId); drag = { a: normPoint(ev), b: normPoint(ev) }; });
overlay.addEventListener("pointermove", (ev) => { if (drag) drag.b = normPoint(ev); });
overlay.addEventListener("pointerup", (ev) => {
  if (!drag) return;
  const { a, b } = drag; drag = null;
  const box = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
  if (!stream) return;
  if (box.w > 0.02 && box.h > 0.02) {
    if (mode !== "region") setMode("region").then(() => trackers.region.start(video, box));
    else trackers.region.start(video, box);
    log("Región seleccionada.");
  } else if (mode === "face" || mode === "object") {
    if (trackers[mode].selectAt(a.x, a.y)) log("Objetivo fijado.");
  }
});

// --- dibujo ---
function drawOverlay() {
  const W = overlay.width, H = overlay.height;
  if (!W) return;
  octx.clearRect(0, 0, W, H);
  // centro + zona muerta
  const dz = num("dead"), fy = num("frameY");
  octx.strokeStyle = "#ffffff30"; octx.lineWidth = Math.max(1, W / 640);
  octx.setLineDash([6, 6]);
  octx.strokeRect((0.5 - dz) * W, (fy - dz) * H, dz * 2 * W, dz * 2 * H);
  octx.setLineDash([]);
  octx.beginPath(); octx.moveTo(W / 2 - 12, fy * H); octx.lineTo(W / 2 + 12, fy * H); octx.moveTo(W / 2, fy * H - 12); octx.lineTo(W / 2, fy * H + 12); octx.stroke();

  const lw = Math.max(2, W / 400);
  if (mode === "face" || mode === "object") {
    octx.lineWidth = lw / 2; octx.strokeStyle = "#ffffff70";
    for (const d of trackers[mode].detections) octx.strokeRect(d.x * W, d.y * H, d.w * W, d.h * H);
  }
  if (target) {
    octx.lineWidth = lw; octx.strokeStyle = locked ? "#ffb547" : "#3ddc84";
    octx.strokeRect(target.x * W, target.y * H, target.w * W, target.h * H);
    const cx = (target.x + target.w / 2) * W, cy = (target.y + target.h / 2) * H;
    octx.fillStyle = octx.strokeStyle; octx.beginPath(); octx.arc(cx, cy, lw * 2, 0, Math.PI * 2); octx.fill();
    octx.beginPath(); octx.moveTo(W / 2, fy * H); octx.lineTo(cx, cy); octx.globalAlpha = 0.4; octx.stroke(); octx.globalAlpha = 1;
  }
  if (drag) {
    octx.lineWidth = lw; octx.strokeStyle = "#3fb6ff";
    const { a, b } = drag;
    octx.strokeRect(Math.min(a.x, b.x) * W, Math.min(a.y, b.y) * H, Math.abs(a.x - b.x) * W, Math.abs(a.y - b.y) * H);
  }
}

function visionLoop(ts) {
  if (stream && video.readyState >= 2 && mode !== "off") {
    try {
      const t = trackers[mode];
      const r = mode === "region" ? t.update(video) : t.update(video, ts);
      if (r) { target = r; lastTargetTime = performance.now(); }
      else if (performance.now() - lastTargetTime > 400) target = null;
    } catch (e) { console.error(e); }
  } else if (mode === "off") target = null;
  drawOverlay();
  updateBadge();
  requestAnimationFrame(visionLoop);
}
requestAnimationFrame(visionLoop);

// ---------------------------------------------------------------------
//  Entradas manuales: teclado, joystick virtual, gamepad
// ---------------------------------------------------------------------
const keys = new Set();
const isTyping = () => ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName) && document.activeElement.type !== "range" && document.activeElement.type !== "checkbox";
window.addEventListener("keydown", (e) => {
  if (isTyping()) return;
  const k = e.key.toLowerCase();
  if (["arrowleft", "arrowright", "arrowup", "arrowdown", " "].includes(k)) e.preventDefault();
  if (e.repeat) { keys.add(k); return; }
  keys.add(k);
  if (k === "c") centerPress();
  if (k === "t") setMode(mode === "off" ? (lastActiveMode || "face") : "off");
  if (k === "m") cycleMode();
  if (k === "r") toggleRec();
  if (k === "p") snapshot();
  if (k === " ") { gimbal.stop(); if (mode !== "off") setMode("off"); }
});
window.addEventListener("keyup", (e) => { keys.delete(e.key.toLowerCase()); if (e.key === "Shift") keys.delete("shift"); });
window.addEventListener("blur", () => keys.clear());
let lastActiveMode = "face";

function keyVector() {
  const k = (...n) => n.some((x) => keys.has(x));
  return {
    yaw: (k("arrowright", "d") ? 1 : 0) - (k("arrowleft", "a") ? 1 : 0),
    pitch: (k("arrowup", "w") ? 1 : 0) - (k("arrowdown", "s") ? 1 : 0),
    roll: (k("e") ? 1 : 0) - (k("q") ? 1 : 0),
    fast: keys.has("shift"),
  };
}

// joystick virtual
const joy = $("joy"), knob = $("joyKnob");
let joyVec = { x: 0, y: 0 };
function joyMove(ev) {
  const r = joy.getBoundingClientRect();
  const R = r.width / 2 - 20;
  let dx = ev.clientX - (r.left + r.width / 2), dy = ev.clientY - (r.top + r.height / 2);
  const d = Math.hypot(dx, dy);
  if (d > R) { dx *= R / d; dy *= R / d; }
  knob.style.transform = `translate(${dx}px, ${dy}px)`;
  joyVec = { x: dx / R, y: -dy / R };
}
joy.addEventListener("pointerdown", (ev) => { joy.setPointerCapture(ev.pointerId); joy.classList.add("active"); joyMove(ev); });
joy.addEventListener("pointermove", (ev) => joy.classList.contains("active") && joyMove(ev));
const joyEnd = () => { joy.classList.remove("active"); knob.style.transform = ""; joyVec = { x: 0, y: 0 }; };
joy.addEventListener("pointerup", joyEnd);
joy.addEventListener("pointercancel", joyEnd);

$("rollSlider").addEventListener("pointerup", () => ($("rollSlider").value = 0));
$("rollSlider").addEventListener("change", () => ($("rollSlider").value = 0));

// gamepad
const padPrev = {};
function gamepadVector() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const p of pads) {
    if (!p) continue;
    const dz = (v) => (Math.abs(v) < 0.15 ? 0 : (v - Math.sign(v) * 0.15) / 0.85);
    const btn = (i) => !!p.buttons[i]?.pressed;
    const edge = (i, fn) => { if (btn(i) && !padPrev[p.index + ":" + i]) fn(); padPrev[p.index + ":" + i] = btn(i); };
    edge(0, centerPress); edge(1, cycleMode); edge(2, toggleRec);
    return { yaw: dz(p.axes[0] || 0), pitch: -dz(p.axes[1] || 0), roll: dz(p.axes[2] || 0) };
  }
  return { yaw: 0, pitch: 0, roll: 0 };
}

// ---------------------------------------------------------------------
//  Los 3 botones del mango
// ---------------------------------------------------------------------
function cycleMode() {
  const next = MODE_ORDER[(MODE_ORDER.indexOf(mode) + 1) % MODE_ORDER.length];
  setMode(next);
}
$("btnMode").onclick = cycleMode;

let centerTimer = null;
function centerPress() {
  if (locked) { locked = false; $("btnCenter").classList.remove("locked"); log("Bloqueo desactivado."); return; }
  gimbal.recenter();
  log("Centrar.");
}
$("btnCenter").addEventListener("pointerdown", () => {
  centerTimer = setTimeout(() => {
    centerTimer = null; locked = true; gimbal.stop();
    $("btnCenter").classList.add("locked"); log("🔒 Bloqueado: el seguimiento no mueve el gimbal. Tocá Centrar para liberar.");
  }, 600);
});
$("btnCenter").addEventListener("pointerup", () => { if (centerTimer) { clearTimeout(centerTimer); centerTimer = null; centerPress(); } });
$("btnCenter").addEventListener("pointerleave", () => { if (centerTimer) { clearTimeout(centerTimer); centerTimer = null; } });

// grabación
let rec = null, recChunks = [], recStart = 0, recTimer = null;
function toggleRec() {
  if (!stream) { log("Iniciá la cámara para grabar."); return; }
  if (rec) { rec.stop(); return; }
  const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m));
  rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
  recChunks = [];
  rec.ondataavailable = (e) => e.data.size && recChunks.push(e.data);
  rec.onstop = () => {
    download(new Blob(recChunks, { type: "video/webm" }), `osmo_${stamp()}.webm`);
    rec = null; clearInterval(recTimer);
    $("btnRec").classList.remove("recording"); $("recBadge").classList.add("hidden");
    log("Grabación guardada.");
  };
  rec.start(1000);
  recStart = Date.now();
  $("btnRec").classList.add("recording"); $("recBadge").classList.remove("hidden");
  recTimer = setInterval(() => {
    const s = Math.floor((Date.now() - recStart) / 1000);
    $("recTime").textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }, 500);
}
$("btnRec").onclick = toggleRec;

function snapshot() {
  if (!stream) return;
  const c = document.createElement("canvas");
  c.width = video.videoWidth; c.height = video.videoHeight;
  c.getContext("2d").drawImage(video, 0, 0);
  c.toBlob((b) => download(b, `osmo_${stamp()}.png`), "image/png");
}
$("btnSnap").onclick = snapshot;
$("btnStop").onclick = () => { gimbal.stop(); setMode("off"); };
$("btnTest").onclick = async () => {
  if (!gimbal.connected) { log("Conectá el gimbal primero."); return; }
  log("Prueba: derecha 1 s, izquierda 1 s. Si gira al revés, marcá «Invertir paneo».");
  testUntil = performance.now() + 2000;
};
let testUntil = 0;

const stamp = () => new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------------------------------------------------------------------
//  Bucle de control (20 Hz)
// ---------------------------------------------------------------------
let out = { yaw: 0, pitch: 0 };
let prevErr = null;

function controlTick() {
  const now = performance.now();
  if (mode !== "off") lastActiveMode = mode;

  const kv = keyVector(), gp = gamepadVector();
  const rollIn = parseFloat($("rollSlider").value) || 0;
  let man = {
    yaw: clamp1(kv.yaw + joyVec.x + gp.yaw),
    pitch: clamp1(kv.pitch + joyVec.y + gp.pitch),
    roll: clamp1(kv.roll + gp.roll + rollIn),
  };
  // curva suave para el joystick (más precisión cerca del centro)
  const curve = (v) => Math.sign(v) * v * v;
  const manSpeed = num("manSpeed") * (kv.fast ? 2 : 1);

  let yaw = 0, pitch = 0, roll = 0;
  if (now < testUntil) {
    yaw = (testUntil - now > 1000 ? 1 : -1) * 30;
  } else if (Math.abs(man.yaw) + Math.abs(man.pitch) + Math.abs(man.roll) > 0.01) {
    yaw = curve(man.yaw) * manSpeed;
    pitch = curve(man.pitch) * manSpeed;
    roll = curve(man.roll) * manSpeed * 0.5;
    out = { yaw: 0, pitch: 0 }; prevErr = null;
  } else if (mode !== "off" && target && !locked) {
    const cx = target.x + target.w / 2, cy = target.y + target.h / 2;
    const dz = num("dead");
    let ex = cx - 0.5, ey = num("frameY") - cy;   // ey > 0 → el objetivo está arriba → subir
    const shape = (e) => (Math.abs(e) < dz ? 0 : e - Math.sign(e) * dz);
    ex = shape(ex); ey = on("trackPitch") ? shape(ey) : 0;
    const kp = num("kp"), max = num("trackMax"), a = num("smooth");
    // término derivativo pequeño para anticipar movimiento
    const kd = kp * 0.15;
    const dx = prevErr ? (ex - prevErr.x) * 20 : 0, dy = prevErr ? (ey - prevErr.y) * 20 : 0;
    prevErr = { x: ex, y: ey };
    const ty = clampAbs(ex * kp + dx * kd, max), tp = clampAbs(ey * kp + dy * kd, max);
    out.yaw = out.yaw * a + ty * (1 - a);
    out.pitch = out.pitch * a + tp * (1 - a);
    yaw = out.yaw; pitch = out.pitch;
  } else {
    out = { yaw: 0, pitch: 0 }; prevErr = null;
  }

  if (on("invYaw")) yaw = -yaw;
  if (on("invPitch")) pitch = -pitch;
  if (gimbal.connected) gimbal.setSpeed(round1(yaw), round1(pitch), round1(roll));
}
const clamp1 = (v) => Math.max(-1, Math.min(1, v));
const clampAbs = (v, m) => Math.max(-m, Math.min(m, v));
const round1 = (v) => Math.round(v * 10) / 10;
setInterval(controlTick, 50);

// ---------------------------------------------------------------------
loadSettings();
bindOutputs();
wrap.classList.toggle("mirror", on("chkMirror"));
if (!navigator.bluetooth) log("⚠ Este navegador no tiene Web Bluetooth. Abrí la app en Chrome o Edge (Windows 10/11).");
if (!window.isSecureContext) log("⚠ Abrí la app con iniciar.bat (http://localhost) para que funcionen Bluetooth y cámara.");
log("Listo. 1) Conectar gimbal  2) Iniciar cámara  3) Elegir seguimiento.");
