// =====================================================================
//  DUML — protocolo de mensajes de DJI (el mismo que usan drones y gimbals)
//
//  Estructura de un paquete:
//   [0]    0x55                       inicio
//   [1..2] longitud (10 bits) | versión (6 bits) << 10   (little endian)
//   [3]    CRC8 de los bytes 0..2   (init 0x77, poly 0x31 reflejado)
//   [4]    emisor   (tipo | índice << 5)
//   [5]    receptor (tipo | índice << 5)
//   [6..7] secuencia (uint16 LE)
//   [8]    tipo de comando / flags de ACK
//   [9]    cmd_set   (0x04 = gimbal)
//   [10]   cmd_id    (0x0C = control de velocidad, 0x14 = ángulo)
//   [11..] payload
//   [n-2..n-1] CRC16 de todo lo anterior (init 0x3692, poly 0x1021 reflejado)
//
//  Los nombres de los comandos coinciden con las clases que aparecen en el
//  APK de DJI GO (dji.midware.data.model.P3.DataGimbalSpeedControl,
//  DataGimbalAbsAngleControl, DataGimbalGetPushParams, etc.).
// =====================================================================

function makeCrc8Table() {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x8c : c >>> 1;
    t[i] = c;
  }
  return t;
}
function makeCrc16Table() {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x8408 : c >>> 1;
    t[i] = c;
  }
  return t;
}
const CRC8 = makeCrc8Table();
const CRC16 = makeCrc16Table();

export function crc8(bytes, init = 0x77) {
  let c = init;
  for (const b of bytes) c = CRC8[(b ^ c) & 0xff];
  return c;
}
export function crc16(bytes, init = 0x3692) {
  let c = init;
  for (const b of bytes) c = (c >>> 8) ^ CRC16[(b ^ c) & 0xff];
  return c & 0xffff;
}

export const CMD = {
  GIMBAL_SET: 0x04,
  GIMBAL_PARAMS_PUSH: 0x05, // DataGimbalGetPushParams (actitud)
  GIMBAL_SPEED: 0x0c,       // DataGimbalSpeedControl
  GIMBAL_ANGLE: 0x14,       // DataGimbalAbsAngleControl
};

export const ROT_MODE = { RELATIVE: 0x04, ABSOLUTE: 0x05, SPEED: 0x80 };

export class DumlBuilder {
  constructor({ sender = 0x02, receiver = 0x04 } = {}) {
    this.sender = sender;
    this.receiver = receiver;
    this.seq = 1;
  }

  build(cmdSet, cmdId, payload = [], cmdType = 0x00) {
    const len = 11 + payload.length + 2;
    const p = new Uint8Array(len);
    p[0] = 0x55;
    const lv = (len & 0x3ff) | (1 << 10); // versión 1
    p[1] = lv & 0xff;
    p[2] = (lv >> 8) & 0xff;
    p[3] = crc8(p.subarray(0, 3));
    p[4] = this.sender;
    p[5] = this.receiver;
    p[6] = this.seq & 0xff;
    p[7] = (this.seq >> 8) & 0xff;
    this.seq = (this.seq + 1) & 0xffff;
    p[8] = cmdType;
    p[9] = cmdSet;
    p[10] = cmdId;
    p.set(payload, 11);
    const c = crc16(p.subarray(0, len - 2));
    p[len - 2] = c & 0xff;
    p[len - 1] = (c >> 8) & 0xff;
    return p;
  }

  /**
   * Movimiento del gimbal.
   *  - mode SPEED:    yaw/pitch/roll en décimas de °/s   (cmd 0x0C)
   *  - mode ABSOLUTE: yaw/pitch/roll en décimas de grado (cmd 0x14)
   *  - mode RELATIVE: idem, relativo a la posición actual (cmd 0x14)
   *  time: duración en décimas de segundo (0..255)
   */
  rotate({ yaw = 0, pitch = 0, roll = 0, mode = ROT_MODE.SPEED, time = 10 }) {
    const pl = new Uint8Array(8);
    const dv = new DataView(pl.buffer);
    dv.setInt16(0, clamp16(yaw), true);
    dv.setInt16(2, clamp16(roll), true);
    dv.setInt16(4, clamp16(pitch), true);
    pl[6] = mode;
    pl[7] = Math.max(0, Math.min(255, time | 0));
    const cmd = mode === ROT_MODE.SPEED ? CMD.GIMBAL_SPEED : CMD.GIMBAL_ANGLE;
    return this.build(CMD.GIMBAL_SET, cmd, pl);
  }
}

function clamp16(v) {
  return Math.max(-32768, Math.min(32767, Math.round(v)));
}

export class DumlParser {
  constructor() { this.buf = new Uint8Array(0); }

  *feed(data) {
    const nb = new Uint8Array(this.buf.length + data.length);
    nb.set(this.buf); nb.set(data, this.buf.length);
    this.buf = nb;
    while (this.buf.length) {
      if (this.buf[0] !== 0x55) {
        const i = this.buf.indexOf(0x55);
        this.buf = i < 0 ? new Uint8Array(0) : this.buf.subarray(i);
        continue;
      }
      if (this.buf.length < 4) break;
      if (crc8(this.buf.subarray(0, 3)) !== this.buf[3]) { this.buf = this.buf.subarray(1); continue; }
      const len = (this.buf[1] | (this.buf[2] << 8)) & 0x3ff;
      if (len < 13) { this.buf = this.buf.subarray(1); continue; }
      if (this.buf.length < len) break;
      const pkt = this.buf.slice(0, len);
      this.buf = this.buf.subarray(len);
      const crcOk = crc16(pkt.subarray(0, len - 2)) === (pkt[len - 2] | (pkt[len - 1] << 8));
      yield {
        len, crcOk,
        sender: pkt[4], receiver: pkt[5],
        seq: pkt[6] | (pkt[7] << 8),
        cmdType: pkt[8], cmdSet: pkt[9], cmdId: pkt[10],
        payload: pkt.slice(11, len - 2),
        raw: pkt,
      };
    }
  }
}

export const hex = (a) => Array.from(a, (b) => b.toString(16).padStart(2, "0")).join(" ");
