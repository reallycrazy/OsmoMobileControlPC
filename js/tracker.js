// =====================================================================
//  Seguimiento: cara (MediaPipe), persona/objeto (MediaPipe) y región
//  libre (correlación de plantilla, funciona sin internet).
//  Todos devuelven { x, y, w, h, score } normalizado 0..1 o null.
// =====================================================================

const MP_VER = "0.10.14";
const MP_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}`;
const MODELS = {
  face: "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite",
  object: "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite",
};

let visionPromise = null;
async function loadVision() {
  if (!visionPromise) {
    visionPromise = (async () => {
      const mp = await import(`${MP_URL}/vision_bundle.mjs`);
      const fileset = await mp.FilesetResolver.forVisionTasks(`${MP_URL}/wasm`);
      return { mp, fileset };
    })();
    visionPromise.catch(() => (visionPromise = null));
  }
  return visionPromise;
}

async function createTask(kind, delegate) {
  const { mp, fileset } = await loadVision();
  const base = { baseOptions: { modelAssetPath: MODELS[kind], delegate }, runningMode: "VIDEO" };
  if (kind === "face") return mp.FaceDetector.createFromOptions(fileset, { ...base, minDetectionConfidence: 0.5 });
  return mp.ObjectDetector.createFromOptions(fileset, { ...base, scoreThreshold: 0.4, maxResults: 10 });
}

async function createTaskSafe(kind) {
  try { return await createTask(kind, "GPU"); } catch { return await createTask(kind, "CPU"); }
}

const iou = (a, b) => {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a.w * a.h + b.w * b.h - inter + 1e-9);
};
const center = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const dist = (a, b) => Math.hypot(center(a).x - center(b).x, center(a).y - center(b).y);

// ---------------------------------------------------------------------
//  Detector (cara u objeto) con asociación al objetivo anterior
// ---------------------------------------------------------------------
export class DetectorTracker {
  constructor(kind) {
    this.kind = kind;         // "face" | "object"
    this.task = null;
    this.loading = null;
    this.target = null;       // última caja seguida
    this.lockedClass = "person";
    this.detections = [];
    this.lastTs = -1;
  }

  async init() {
    if (this.task) return;
    if (!this.loading) this.loading = createTaskSafe(this.kind).then((t) => (this.task = t));
    await this.loading;
  }

  /** Fijar un objetivo concreto haciendo click sobre él. */
  selectAt(px, py) {
    const hit = this.detections.filter((d) => px >= d.x && px <= d.x + d.w && py >= d.y && py <= d.y + d.h)
      .sort((a, b) => a.w * a.h - b.w * b.h)[0];
    if (hit) { this.target = hit; if (hit.label) this.lockedClass = hit.label; return true; }
    return false;
  }

  reset() { this.target = null; }

  update(video, ts) {
    if (!this.task || video.readyState < 2) return this.target;
    if (ts <= this.lastTs) ts = this.lastTs + 1;
    this.lastTs = ts;
    const W = video.videoWidth, H = video.videoHeight;
    const res = this.task.detectForVideo(video, ts);
    let dets = (res.detections || []).map((d) => {
      const b = d.boundingBox, c = d.categories?.[0];
      return { x: b.originX / W, y: b.originY / H, w: b.width / W, h: b.height / H, score: c?.score ?? 1, label: c?.categoryName || "cara" };
    });
    if (this.kind === "object" && this.lockedClass) dets = dets.filter((d) => d.label === this.lockedClass);
    this.detections = dets;
    if (!dets.length) { this.lostFrames = (this.lostFrames || 0) + 1; if (this.lostFrames > 15) this.target = null; return null; }
    this.lostFrames = 0;

    let best;
    if (this.target) {
      // la caja que más se superpone / está más cerca del objetivo anterior
      best = dets.map((d) => ({ d, s: iou(d, this.target) * 2 - dist(d, this.target) })).sort((a, b) => b.s - a.s)[0].d;
      if (dist(best, this.target) > 0.35 && iou(best, this.target) === 0) {
        this.lostFrames = 1; return null; // salto demasiado grande: probablemente otra persona
      }
    } else {
      best = dets.slice().sort((a, b) => b.w * b.h - a.w * a.h)[0]; // la más grande
    }
    this.target = best;
    return best;
  }
}

// ---------------------------------------------------------------------
//  Región libre: correlación cruzada normalizada (NCC) sobre grises
// ---------------------------------------------------------------------
export class RegionTracker {
  constructor() {
    this.cv = document.createElement("canvas");
    this.ctx = this.cv.getContext("2d", { willReadFrequently: true });
    this.W = 320; this.H = 180;
    this.tpl = null; this.tw = 0; this.th = 0;
    this.pos = null;   // esquina superior izquierda en px de la imagen reducida
    this.box = null;   // tamaño original en px reducidos
    this.target = null;
    this.score = 0;
  }

  _gray(video) {
    const ar = video.videoHeight / video.videoWidth || 9 / 16;
    this.H = Math.round(this.W * ar);
    if (this.cv.width !== this.W || this.cv.height !== this.H) { this.cv.width = this.W; this.cv.height = this.H; }
    this.ctx.drawImage(video, 0, 0, this.W, this.H);
    const d = this.ctx.getImageData(0, 0, this.W, this.H).data;
    const g = new Float32Array(this.W * this.H);
    for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    return g;
  }

  /** box normalizado {x,y,w,h} */
  start(video, box) {
    const g = this._gray(video);
    const bw = Math.max(8, box.w * this.W), bh = Math.max(8, box.h * this.H);
    // la plantilla se submuestrea a ≤ 32 px de lado para que sea rápida
    this.step = Math.max(1, Math.round(Math.max(bw, bh) / 32));
    this.tw = Math.max(4, Math.floor(bw / this.step));
    this.th = Math.max(4, Math.floor(bh / this.step));
    this.pos = { x: box.x * this.W, y: box.y * this.H };
    this.tpl = this._patch(g, this.pos.x, this.pos.y);
    this.target = { ...box, score: 1 };
  }

  reset() { this.tpl = null; this.target = null; }

  _patch(g, x0, y0) {
    const { tw, th, step, W } = this, n = tw * th, p = new Float32Array(n);
    let s = 0;
    for (let j = 0; j < th; j++) for (let i = 0; i < tw; i++) {
      const v = g[(Math.round(y0) + j * step) * W + Math.round(x0) + i * step] || 0;
      p[j * tw + i] = v; s += v;
    }
    const m = s / n; let q = 0;
    for (let k = 0; k < n; k++) { p[k] -= m; q += p[k] * p[k]; }
    const nrm = Math.sqrt(q) || 1;
    for (let k = 0; k < n; k++) p[k] /= nrm;
    return p;
  }

  _ncc(g, x0, y0) {
    const { tw, th, step, W, tpl } = this, n = tw * th;
    let s = 0, s2 = 0, st = 0;
    for (let j = 0; j < th; j++) {
      const row = (y0 + j * step) * W + x0;
      for (let i = 0; i < tw; i++) {
        const v = g[row + i * step], t = tpl[j * tw + i];
        s += v; s2 += v * v; st += v * t;
      }
    }
    const varr = s2 - (s * s) / n;
    return varr > 1e-3 ? st / Math.sqrt(varr) : 0; // la plantilla ya tiene media 0 y norma 1
  }

  update(video) {
    if (!this.tpl || video.readyState < 2) return null;
    const g = this._gray(video);
    const { W, H, tw, th, step } = this;
    const bw = tw * step, bh = th * step;
    const R = Math.round(Math.max(12, Math.max(bw, bh) * 0.6));
    const px = Math.round(this.pos.x), py = Math.round(this.pos.y);
    let best = -2, bx = px, by = py;
    const search = (cx, cy, r, s) => {
      for (let y = cy - r; y <= cy + r; y += s) {
        if (y < 0 || y + bh >= H) continue;
        for (let x = cx - r; x <= cx + r; x += s) {
          if (x < 0 || x + bw >= W) continue;
          const v = this._ncc(g, x, y);
          if (v > best) { best = v; bx = x; by = y; }
        }
      }
    };
    search(px, py, R, 3);          // búsqueda gruesa
    const cx = bx, cy = by; best = -2;
    search(cx, cy, 3, 1);          // refinamiento
    this.score = best;
    if (best < 0.45) { this.lost = (this.lost || 0) + 1; return this.lost > 10 ? (this.target = null) : null; }
    this.lost = 0;
    this.pos = { x: bx, y: by };
    // adaptación lenta de la plantilla (cambios de luz/pose)
    if (best > 0.8) {
      const np = this._patch(g, bx, by);
      let q = 0;
      for (let k = 0; k < np.length; k++) { this.tpl[k] = this.tpl[k] * 0.9 + np[k] * 0.1; q += this.tpl[k] ** 2; }
      const nrm = Math.sqrt(q) || 1; for (let k = 0; k < np.length; k++) this.tpl[k] /= nrm;
    }
    this.target = { x: bx / W, y: by / H, w: bw / W, h: bh / H, score: best };
    return this.target;
  }
}
