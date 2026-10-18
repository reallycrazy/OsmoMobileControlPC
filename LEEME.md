# Osmo Control PC

Con esta app controlás un **DJI Osmo Mobile** desde la PC por Bluetooth LE, con seguimiento de cara, persona/objeto o una región elegida con la webcam. También tiene control manual por teclado, joystick virtual, los 3 botones del mango y gamepad USB.

## Cómo usarla
1. Encendé el Osmo. **No** lo emparejes desde la configuración Bluetooth de Windows: la app se conecta sola. Si ya está emparejado, quitalo de la lista.
2. Hacé doble click en **`iniciar.bat`**. Levanta un servidor local en `http://localhost:8765` y abre Chrome o Edge en modo app.
   *(Para que funcionen el Bluetooth y la cámara, la página tiene que abrirse desde localhost o https. Si la abrís como archivo, no van a andar.)*
3. **Conectar gimbal** → elegí el Osmo en la lista (suele llamarse "Osmo Mobile…" u "OM…").
4. **Iniciar cámara** → elegí la webcam.
5. Elegí el seguimiento: **Cara**, **Persona/objeto** o **Región** (para Región, arrastrá un rectángulo sobre el video).
6. Usá **↔ Probar**. Si el gimbal gira al revés de lo que muestra la cámara, marcá *Invertir paneo* o *Invertir inclinación*.

> Para que el seguimiento tenga sentido, **la cámara tiene que ir montada en el gimbal**. Puede ser una webcam USB sujeta en la pinza, o el celular usado como webcam con DroidCam, Iriun o Camo.

## Controles
| Acción | Teclado | Pantalla | Gamepad |
|---|---|---|---|
| Paneo / inclinación | ← → ↑ ↓ o WASD | Joystick | Stick izquierdo |
| Roll | Q / E | Slider Roll | Stick derecho X |
| Rápido | Shift | — | — |
| Centrar | C | ⟲ (click) | A |
| Bloquear (pausa el seguimiento) | — | ⟲ (mantener) | — |
| Cambiar modo | M | M | B |
| Seguimiento on/off | T | — | — |
| Grabar / Foto | R / P | ● / 📷 | X |
| Detener todo | Espacio | ■ Detener | — |

El control manual siempre tiene prioridad sobre el seguimiento.

## Requisitos
- Windows 10 u 11 con Bluetooth 4.0 (BLE). Sirve también un adaptador USB.
- Chrome o Edge (Firefox no soporta Web Bluetooth).
- Internet la primera vez que uses **Cara** o **Persona/objeto**: los modelos de MediaPipe se descargan de Google y quedan en caché. **Región** funciona sin internet.

## Protocolo (resumen técnico)
- Servicio BLE `0xFFF0`. Las notificaciones llegan por `0xFFF4` y la escritura va por `0xFFF5`, en trozos de 20 bytes.
- Los mensajes usan **DUML**: `55 | len | crc8 | emisor 02 | receptor 04 | seq | 00 | cmd_set | cmd | payload | crc16`.
  - CRC8: init 0x77, poly 0x31 reflejado. CRC16: init 0x3692, poly 0x1021 reflejado.
- `cmd_set 0x04` (gimbal):
  - `cmd 0x0C` = velocidad (`DataGimbalSpeedControl`). Payload: yaw, roll, pitch en int16 LE (décimas de °/s), luego `0x80` y el tiempo en décimas de segundo.
  - `cmd 0x14` = ángulo (`DataGimbalAbsAngleControl`). Mismo payload, con modo `0x05` absoluto o `0x04` relativo.
  - `cmd 0x05` = push de actitud (pitch, roll, yaw en décimas de grado).
- Si tu Osmo no responde, en **Avanzado / diagnóstico** podés cambiar los UUID y las direcciones, ver lo que se manda y recibe (TX/RX) y mandar paquetes DUML a mano.

Basado en el análisis del APK DJI GO 3 y en el proyecto abierto [alkersan/om-research](https://github.com/alkersan/om-research) (MIT).
