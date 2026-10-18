// =====================================================================
//  Conexión Bluetooth LE con el Osmo Mobile (Web Bluetooth)
//  Servicio 0xFFF0 · notificaciones en 0xFFF4 · escritura en 0xFFF5
// =====================================================================
import { DumlBuilder, DumlParser, ROT_MODE, CMD, hex } from "./duml.js";

export const DEFAULT_UUIDS = {
  service: "0000fff0-0000-1000-8000-00805f9b34fb",
  notify: "0000fff4-0000-1000-8000-00805f9b34fb",
  write: "0000fff5-0000-1000-8000-00805f9b34fb",
};

const toUuid = (s) => {
  s = String(s).trim().toLowerCase();
  if (/^(0x)?[0-9a-f]{4}$/.test(s)) return parseInt(s.replace("0x", ""), 16);
  return s;
};

export class Gimbal extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.writeChar = null;
    this.notifyChar = null;
    this.builder = new DumlBuilder();
    this.parser = new DumlParser();
    this.uuids = { ...DEFAULT_UUIDS };
    this.chunkSize = 20;
    this.busy = false;
    this.pendingSpeed = null;   // último comando de velocidad (gana el más nuevo)
    this.queue = [];            // otros comandos (en orden)
    this.lastSpeedZero = true;
    this.logTx = false;
    this.attitude = null;
  }

  get connected() { return !!(this.device && this.device.gatt.connected); }

  async connect({ namePrefix = "", uuids } = {}) {
    if (!navigator.bluetooth) throw new Error("Este navegador no soporta Web Bluetooth. Usá Chrome o Edge en Windows 10/11.");
    if (uuids) this.uuids = { ...this.uuids, ...uuids };
    const svc = toUuid(this.uuids.service);
    const opts = { optionalServices: [svc, "battery_service", "device_information"] };
    if (namePrefix) opts.filters = [{ namePrefix }];
    else opts.acceptAllDevices = true;

    this.device = await navigator.bluetooth.requestDevice(opts);
    this.device.addEventListener("gattserverdisconnected", () => this._onDisconnect());
    this._emit("log", `Conectando a ${this.device.name || this.device.id}…`);
    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService(svc);

    // Intentamos las características conocidas; si no están, buscamos por propiedades.
    try { this.notifyChar = await service.getCharacteristic(toUuid(this.uuids.notify)); } catch { this.notifyChar = null; }
    try { this.writeChar = await service.getCharacteristic(toUuid(this.uuids.write)); } catch { this.writeChar = null; }
    if (!this.writeChar || !this.notifyChar) {
      const chars = await service.getCharacteristics();
      this._emit("log", "Características encontradas: " + chars.map((c) => `${c.uuid.slice(4, 8)}[${props(c)}]`).join(", "));
      if (!this.notifyChar) this.notifyChar = chars.find((c) => c.properties.notify) || null;
      if (!this.writeChar) this.writeChar = chars.find((c) => c.properties.writeWithoutResponse || c.properties.write) || null;
    }
    if (!this.writeChar) throw new Error("No encontré una característica de escritura en el servicio FFF0.");

    if (this.notifyChar) {
      await this.notifyChar.startNotifications();
      this.notifyChar.addEventListener("characteristicvaluechanged", (e) => this._onNotify(e));
    }
    this._emit("log", `Escritura: ${this.writeChar.uuid.slice(4, 8)} · Notificación: ${this.notifyChar ? this.notifyChar.uuid.slice(4, 8) : "—"}`);
    this._readBattery(server);
    this._emit("connected", this.device.name || "Osmo");
  }

  async _readBattery(server) {
    try {
      const s = await server.getPrimaryService("battery_service");
      const c = await s.getCharacteristic("battery_level");
      const v = await c.readValue();
      this._emit("battery", v.getUint8(0));
      try {
        await c.startNotifications();
        c.addEventListener("characteristicvaluechanged", (e) => this._emit("battery", e.target.value.getUint8(0)));
      } catch {}
    } catch {}
  }

  disconnect() {
    if (this.connected) {
      try { this.stop(); } catch {}
      setTimeout(() => this.device?.gatt.disconnect(), 150);
    }
  }

  _onDisconnect() {
    this.writeChar = this.notifyChar = null;
    this.busy = false; this.queue = []; this.pendingSpeed = null;
    this._emit("disconnected");
  }

  _onNotify(e) {
    const data = new Uint8Array(e.target.value.buffer.slice(e.target.value.byteOffset, e.target.value.byteOffset + e.target.value.byteLength));
    for (const m of this.parser.feed(data)) {
      this._emit("packet", m);
      // Push de parámetros del gimbal (actitud): pitch, roll, yaw en décimas de grado
      if (m.cmdSet === CMD.GIMBAL_SET && m.cmdId === CMD.GIMBAL_PARAMS_PUSH && m.payload.length >= 6) {
        const dv = new DataView(m.payload.buffer, m.payload.byteOffset, m.payload.byteLength);
        this.attitude = { pitch: dv.getInt16(0, true) / 10, roll: dv.getInt16(2, true) / 10, yaw: dv.getInt16(4, true) / 10 };
        this._emit("attitude", this.attitude);
      }
      // Batería del mango (cmd_set 0x05 / cmd 0x06 en OM2–OM4)
      if (m.cmdSet === 0x05 && m.cmdId === 0x06 && m.payload.length >= 1) {
        this._emit("battery", m.payload[0]);
      }
    }
  }

  // ---------- API de alto nivel ----------

  /** Velocidad en °/s (se convierte a décimas). Se envía continuamente desde el bucle de la app. */
  setSpeed(yawDps, pitchDps, rollDps = 0) {
    const zero = Math.abs(yawDps) < 0.05 && Math.abs(pitchDps) < 0.05 && Math.abs(rollDps) < 0.05;
    if (zero && this.lastSpeedZero) return; // no inundar con ceros
    this.lastSpeedZero = zero;
    this.pendingSpeed = this.builder.rotate({ yaw: yawDps * 10, pitch: pitchDps * 10, roll: rollDps * 10, mode: ROT_MODE.SPEED, time: 5 });
    this._pump();
  }

  stop() {
    this.lastSpeedZero = false;
    this.setSpeed(0, 0, 0);
  }

  /** Ángulo absoluto en grados, duración en segundos. */
  moveTo(yaw, pitch, roll = 0, seconds = 1) {
    this.pendingSpeed = null;
    this.lastSpeedZero = true;
    this.send(this.builder.rotate({ yaw: yaw * 10, pitch: pitch * 10, roll: roll * 10, mode: ROT_MODE.ABSOLUTE, time: seconds * 10 }));
  }

  /** Giro relativo a la posición actual. */
  moveBy(yaw, pitch, roll = 0, seconds = 1) {
    this.send(this.builder.rotate({ yaw: yaw * 10, pitch: pitch * 10, roll: roll * 10, mode: ROT_MODE.RELATIVE, time: seconds * 10 }));
  }

  recenter() { this.moveTo(0, 0, 0, 1); }

  /** Paquete DUML arbitrario (para experimentar). */
  sendRaw(cmdSet, cmdId, payload, cmdType = 0) {
    this.send(this.builder.build(cmdSet, cmdId, payload, cmdType));
  }

  send(pkt) { this.queue.push(pkt); this._pump(); }

  async _pump() {
    if (this.busy || !this.writeChar) return;
    this.busy = true;
    try {
      while (this.writeChar && (this.queue.length || this.pendingSpeed)) {
        const pkt = this.queue.length ? this.queue.shift() : this.pendingSpeed;
        if (pkt === this.pendingSpeed) this.pendingSpeed = null;
        await this._write(pkt);
      }
    } catch (err) {
      this._emit("log", "Error de escritura: " + (err.message || err));
    } finally {
      this.busy = false;
    }
  }

  async _write(pkt) {
    if (this.logTx) this._emit("tx", hex(pkt));
    const noResp = this.writeChar.properties.writeWithoutResponse;
    for (let o = 0; o < pkt.length; o += this.chunkSize) {
      const chunk = pkt.slice(o, o + this.chunkSize);
      if (noResp) await this.writeChar.writeValueWithoutResponse(chunk);
      else await this.writeChar.writeValueWithResponse(chunk);
    }
  }

  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
}

function props(c) {
  const p = c.properties, out = [];
  if (p.read) out.push("R"); if (p.write) out.push("W"); if (p.writeWithoutResponse) out.push("w");
  if (p.notify) out.push("N"); if (p.indicate) out.push("I");
  return out.join("");
}
