// Trabajador dedicado: pide un trozo, lo descifra y lo entrega a la página (transferido, sin copia).
// Hace un solo intento por encargo; los reintentos y las esperas los decide la página.
//
//   página → trabajador   { tipo: 'inicio', claveBase, credencial, shareIdTexto, shareId, tamTrozo, sinDatosMs, origen }
//                         { tipo: 'origen', origen }                    (modo fijo: el motor cambió de dirección)
//                         { tipo: 'trozo', trabajo, fileId, version, sal, tam, indice }
//                         { tipo: 'cancelar', trabajo }
//   trabajador → página   { tipo: 'listo' }
//                         { tipo: 'recibido', trabajo, bytes }          (avance de red, agrupado)
//                         { tipo: 'hecho', trabajo, datos }             (ArrayBuffer en claro, transferido)
//                         { tipo: 'error', trabajo, clase, codigo, espera, estado, mensaje }
//                         { tipo: 'cancelado', trabajo }

import { crearApi, ErrorApi, esCancelacion } from './api.js';
import { abrir, aadTrozo, derivarClaveArchivo, rangoTrozo, versionABigInt } from './wire.js';

let cfg = null;
let api = null;
const claves = new Map();   // "<fileId>-<version>" → Promise<CryptoKey>
const activos = new Map();  // trabajo → AbortController

// Suelta la memoria del búfer ya, sin esperar al recolector (medido en el prototipo de rendimiento).
function liberar(buf) {
  try {
    if (buf && typeof buf.transfer === 'function' && !buf.detached) buf.transfer(0);
  } catch { /* no disponible: lo recogerá el recolector */ }
}

function claveDe(m) {
  const k = `${m.fileId}-${m.version}`;
  let p = claves.get(k);
  if (!p) {
    p = derivarClaveArchivo(cfg.claveBase, m.sal);
    claves.set(k, p);
    if (claves.size > 64) claves.delete(claves.keys().next().value);
  }
  return p;
}

async function hacer(m) {
  const ctrl = new AbortController();
  activos.set(m.trabajo, ctrl);
  let cuerpo = null;
  // Avance de red agrupado: como mucho un mensaje cada 200 ms.
  let pendiente = 0;
  let ultimo = 0;
  const avisar = (forzar) => {
    const ahora = performance.now();
    if (pendiente && (forzar || ahora - ultimo >= 200)) {
      self.postMessage({ tipo: 'recibido', trabajo: m.trabajo, bytes: pendiente });
      pendiente = 0;
      ultimo = ahora;
    }
  };
  try {
    const r = rangoTrozo(m.tam, cfg.tamTrozo, m.indice);
    if (!r) throw new ErrorApi('manifiesto', 'trozo_fuera_de_rango');
    const version = versionABigInt(m.version);
    const [clave, datos] = await Promise.all([
      claveDe(m),
      api.trozo(m.fileId, m.version, m.indice, r.longitud, ctrl.signal, (n) => { pendiente += n; avisar(false); }),
    ]);
    cuerpo = datos;
    avisar(true);
    let claro;
    try {
      claro = await abrir(clave, cuerpo, aadTrozo(cfg.shareId, m.fileId, version, cfg.tamTrozo, m.indice, r.esUltimo));
    } catch {
      throw new ErrorApi('integridad', 'autenticacion');
    }
    liberar(cuerpo);
    cuerpo = null;
    // La longitud en claro tiene que ser exactamente la que dice el manifiesto.
    if (claro.byteLength !== r.longitud) {
      liberar(claro);
      throw new ErrorApi('integridad', 'longitud');
    }
    if (ctrl.signal.aborted) {
      liberar(claro);
      throw new DOMException('Cancelado', 'AbortError');
    }
    self.postMessage({ tipo: 'hecho', trabajo: m.trabajo, datos: claro }, [claro]);
  } catch (e) {
    liberar(cuerpo);
    if (esCancelacion(e)) self.postMessage({ tipo: 'cancelado', trabajo: m.trabajo });
    else if (e instanceof ErrorApi) {
      self.postMessage({ tipo: 'error', trabajo: m.trabajo, clase: e.clase, codigo: e.codigo, espera: e.espera, estado: e.estado, mensaje: '' });
    } else {
      self.postMessage({ tipo: 'error', trabajo: m.trabajo, clase: 'red', codigo: 'interno', espera: 0, estado: 0, mensaje: String((e && e.message) || e) });
    }
  } finally {
    activos.delete(m.trabajo);
  }
}

self.onmessage = (ev) => {
  const m = ev.data;
  if (m.tipo === 'inicio') {
    cfg = m;
    api = crearApi({ shareIdTexto: m.shareIdTexto, credencial: m.credencial, sinDatosMs: m.sinDatosMs, origen: m.origen || '' });
    claves.clear();
    self.postMessage({ tipo: 'listo' });
  } else if (m.tipo === 'origen') {
    // Los encargos en curso los cancela la página; los siguientes ya van a la dirección nueva.
    if (api) api.cambiarOrigen(m.origen || '');
  } else if (m.tipo === 'trozo') {
    hacer(m);
  } else if (m.tipo === 'cancelar') {
    const c = activos.get(m.trabajo);
    if (c) c.abort();
  }
};
