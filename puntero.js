// Modo fijo (docs/PROTOCOLO.md, sección 10): la página vive en un origen fijo y pregunta en un «punto
// de encuentro» dónde está el motor. Aquí: modo de la página, claves del puntero, petición, descifrado
// y validación. Sin dependencias: funciona igual en la página y en Node (pruebas).
//
//   idPuntero    = primeros 16 bytes de HKDF-SHA256(secreto, salt vacío, info = "lata/v1/puntero-id")
//   clavePuntero = HKDF-SHA256(secreto, salt vacío, info = "lata/v1/puntero-cifra")        (AES-256-GCM)
//   registro     = { "v": 1, "pk": …, "seq": n, "caja": <b64u>, "firma": … }               (JSON, ≤ 2048 bytes)
//   caja         = nonce (12) || AES-256-GCM(clavePuntero, nonce, claro, AAD) con su etiqueta (16)
//   AAD          = "lata/v1/puntero" || idPuntero (16) || seq (u64)
//   claro        = { "o": <origen del motor>, "s": <shareId>, "t": <segundos Unix>, "e": "activo" | "revocado" }
//
// `pk` y `firma` son para el punto de encuentro, que no tiene el secreto. Ante la página la
// autenticidad la da el cifrado: solo quien tiene el secreto puede producir una caja que se abra.
// El secreto no sale de aquí: al punto de encuentro solo viaja idPuntero, que no permite deducirlo.

import { abrir, b64uABytes, bytesAB64u, leerEnlace, SOBRECARGA } from './wire.js';

const te = new TextEncoder();
const td = new TextDecoder('utf-8', { fatal: true });

export const REGISTRO_MAX = 2048;   // bytes del registro tal como lo sirve el punto de encuentro
export const CLARO_MAX = 512;       // bytes del JSON que va dentro de la caja
export const PLAZO_PUNTERO_MS = 15000;

const INFO_ID = te.encode('lata/v1/puntero-id');
const INFO_CIFRA = te.encode('lata/v1/puntero-cifra');
const PREFIJO_AAD = te.encode('lata/v1/puntero');
const SIN_SAL = new Uint8Array(0);

const hkdf = (info) => ({ name: 'HKDF', hash: 'SHA-256', salt: SIN_SAL, info });

// codigo: 'no_existe'     el punto de encuentro no tiene puntero con ese nombre (404)
//         'inalcanzable'  no responde, responde otra cosa o pide esperar (429); `espera` en segundos si la indica
//         'no_valido'     hay registro, pero no se puede abrir con este enlace o no cumple el contrato
export class ErrorPuntero extends Error {
  constructor(codigo, detalle = '', espera = 0) {
    super(`puntero ${codigo}${detalle ? ': ' + detalle : ''}`);
    this.name = 'ErrorPuntero';
    this.codigo = codigo;
    this.espera = espera;
  }
}

/* ------------------------------------------------------------------ modo de la página */

// Normaliza la dirección del punto de encuentro de config.js. Devuelve '' si no vale: tiene que ser
// https://, o http://127.0.0.1 / http://localhost cuando la propia página se sirve desde ahí (pruebas).
export function encuentroValido(encuentro, paginaLocal) {
  if (typeof encuentro !== 'string' || encuentro === '' || encuentro.length > 500 || /[\s#?]/.test(encuentro)) return '';
  let u;
  try { u = new URL(encuentro); } catch { return ''; }
  if (u.username || u.password) return '';
  const local = u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
  if (u.protocol !== 'https:' && !(local && paginaLocal)) return '';
  return (u.origin + u.pathname).replace(/\/+$/, '');
}

// Sección 10.5: si la ruta es /s/<shareId>, modo clásico. Si no, y el fragmento es un secreto de 43
// caracteres b64u, y config.js trae un punto de encuentro, modo fijo. Devuelve null si el enlace no vale.
//   { modo: 'clasico', shareIdTexto, shareId, secreto } | { modo: 'fijo', secreto, encuentro }
export function leerModo(pathname, hash, encuentro, paginaLocal = false) {
  if (/^\/s\/[A-Za-z0-9_-]{22}\/?$/.test(pathname || '')) {
    const e = leerEnlace(pathname, hash);
    return e ? { modo: 'clasico', ...e } : null;
  }
  const h = String(hash || '').replace(/^#/, '');
  const base = encuentroValido(encuentro, paginaLocal);
  if (!base || !/^[A-Za-z0-9_-]{43}$/.test(h)) return null;
  try {
    const secreto = b64uABytes(h);
    return secreto.length === 32 ? { modo: 'fijo', secreto, encuentro: base } : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ claves */

// Nombre del puntero en el punto de encuentro: 16 bytes. `base` es la clave de importarSecreto().
export async function derivarIdPuntero(base) {
  return new Uint8Array(await crypto.subtle.deriveBits(hkdf(INFO_ID), base, 256)).slice(0, 16);
}

export function derivarClavePuntero(base, usos = ['decrypt']) {
  return crypto.subtle.deriveKey(hkdf(INFO_CIFRA), base, { name: 'AES-GCM', length: 256 }, false, usos);
}

// Bytes en claro de la clave: solo para comprobar los vectores de prueba.
export async function derivarBitsClavePuntero(base) {
  return new Uint8Array(await crypto.subtle.deriveBits(hkdf(INFO_CIFRA), base, 256));
}

// AAD = "lata/v1/puntero" || idPuntero (16) || seq (u64)
export function aadPuntero(idPuntero, seq) {
  if (!(idPuntero instanceof Uint8Array) || idPuntero.length !== 16) throw new Error('idPuntero debe medir 16 bytes');
  if (!Number.isSafeInteger(seq) || seq <= 0) throw new Error('seq fuera de rango');
  const aad = new Uint8Array(PREFIJO_AAD.length + 16 + 8);
  aad.set(PREFIJO_AAD, 0);
  aad.set(idPuntero, PREFIJO_AAD.length);
  new DataView(aad.buffer).setBigUint64(PREFIJO_AAD.length + 16, BigInt(seq), false);
  return aad;
}

/* ------------------------------------------------------------------ validación */

// `o` es un origen sin ruta ni barra final. Tiene que ser https://; se admite http://127.0.0.1:<puerto>
// o http://localhost:<puerto> solo si la propia página está servida desde 127.0.0.1 o localhost.
// Devuelve el origen normalizado, o '' si no vale.
export function origenValido(o, paginaLocal) {
  if (typeof o !== 'string' || o.length > 300 || !/^https?:\/\/[^/?#@\s\\]+$/.test(o)) return '';
  let u;
  try { u = new URL(o); } catch { return ''; }
  if (u.username || u.password || u.pathname !== '/' || u.search || u.hash || !u.hostname) return '';
  if (u.protocol === 'https:') return u.origin;
  const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  return paginaLocal && local && /:\d+$/.test(o) ? u.origin : '';
}

// Abre y valida el registro que devuelve el punto de encuentro (texto o bytes).
// Devuelve { seq, origen, shareIdTexto, shareId, t, estado: 'activo' | 'revocado' }.
// Lanza ErrorPuntero('no_valido') si no se puede abrir con este enlace o no cumple el contrato.
// Comparar `seq` con el mayor ya visto es cosa de quien llama.
export async function abrirPuntero(clave, idPuntero, cuerpo, { paginaLocal = false } = {}) {
  const mal = (t) => { throw new ErrorPuntero('no_valido', t); };
  let texto = cuerpo;
  if (typeof cuerpo !== 'string') {
    const b = cuerpo instanceof Uint8Array ? cuerpo : new Uint8Array(cuerpo);
    if (b.length > REGISTRO_MAX) mal('registro demasiado grande');
    try { texto = td.decode(b); } catch { mal('el registro no es UTF-8'); }
  } else if (te.encode(cuerpo).length > REGISTRO_MAX) mal('registro demasiado grande');
  let r;
  try { r = JSON.parse(texto); } catch { mal('el registro no es JSON'); }
  if (!r || typeof r !== 'object' || Array.isArray(r)) mal('el registro no es un objeto');
  if (r.v !== 1) mal('versión no soportada');
  if (!Number.isSafeInteger(r.seq) || r.seq <= 0) mal('seq');
  let caja;
  try { caja = b64uABytes(r.caja); } catch { mal('caja'); }
  if (caja.length < SOBRECARGA) mal('caja demasiado corta');
  if (caja.length > SOBRECARGA + CLARO_MAX) mal('caja demasiado grande');
  let claro;
  try {
    claro = new Uint8Array(await abrir(clave, caja, aadPuntero(idPuntero, r.seq)));
  } catch {
    mal('la caja no se abre con este enlace');
  }
  if (claro.length > CLARO_MAX) mal('contenido demasiado grande');
  let c;
  try { c = JSON.parse(td.decode(claro)); } catch { mal('el contenido no es JSON'); }
  if (!c || typeof c !== 'object' || Array.isArray(c)) mal('el contenido no es un objeto');
  if (c.e !== 'activo' && c.e !== 'revocado') mal('e');
  if (typeof c.s !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(c.s)) mal('s');
  let shareId;
  try { shareId = b64uABytes(c.s); } catch { mal('s'); }
  if (shareId.length !== 16 || bytesAB64u(shareId) !== c.s) mal('s');
  // Un puntero revocado ya no lleva a ningún sitio: su origen no se usa ni se exige.
  const origen = origenValido(c.o, paginaLocal);
  if (c.e === 'activo' && !origen) mal('o: origen no admitido');
  return { seq: r.seq, origen, shareIdTexto: c.s, shareId, t: Number.isFinite(c.t) ? c.t : 0, estado: c.e };
}

/* ------------------------------------------------------------------ petición */

// GET E/v1/p/<idPuntero>: petición simple, sin cabeceras propias ni credenciales. Devuelve los bytes
// del registro (como mucho 2048). Lanza ErrorPuntero; la cancelación pedida por quien llama sale como AbortError.
export async function pedirPuntero(encuentro, idTexto, { senal, plazoMs = PLAZO_PUNTERO_MS } = {}) {
  const ctrl = new AbortController();
  let vencido = false;
  const t = setTimeout(() => { vencido = true; ctrl.abort(); }, plazoMs);
  const cortar = () => ctrl.abort();
  if (senal) {
    if (senal.aborted) ctrl.abort();
    else senal.addEventListener('abort', cortar, { once: true });
  }
  try {
    const res = await fetch(`${encuentro}/v1/p/${idTexto}`, {
      cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: ctrl.signal,
    });
    if (res.status === 404) {
      try { await res.body.cancel(); } catch { /* da igual */ }
      throw new ErrorPuntero('no_existe');
    }
    if (res.status !== 200) {
      // 429 con Retry-After (si el punto de encuentro deja leerlo), 5xx o cualquier otra cosa.
      const ra = res.headers.get('Retry-After');
      try { await res.body.cancel(); } catch { /* da igual */ }
      const s = typeof ra === 'string' && /^\s*\d+\s*$/.test(ra) ? Math.max(1, Math.min(300, Number(ra))) : (res.status === 429 ? 10 : 0);
      throw new ErrorPuntero('inalcanzable', 'HTTP ' + res.status, s);
    }
    const lector = res.body.getReader();
    const piezas = [];
    let n = 0;
    for (;;) {
      const { done, value } = await lector.read();
      if (done) break;
      n += value.length;
      if (n > REGISTRO_MAX) {
        try { await lector.cancel(); } catch { /* da igual */ }
        throw new ErrorPuntero('no_valido', 'registro demasiado grande');
      }
      piezas.push(value);
    }
    const out = new Uint8Array(n);
    let p = 0;
    for (const x of piezas) { out.set(x, p); p += x.length; }
    return out;
  } catch (e) {
    if (e instanceof ErrorPuntero) throw e;
    if (!vencido && senal && senal.aborted) throw new DOMException('Cancelado', 'AbortError');
    throw new ErrorPuntero('inalcanzable', vencido ? 'sin respuesta' : 'conexión');
  } finally {
    clearTimeout(t);
    if (senal) senal.removeEventListener('abort', cortar);
  }
}
