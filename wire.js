// Formato de cable de Lata v1, lado receptor (docs/PROTOCOLO.md, secciones 1, 2, 4, 5 y 8).
// Sin dependencias: funciona igual en la página, en los trabajadores y en Node (pruebas).
//
//   claveAcceso     = HKDF-SHA256(secreto, salt = shareId, info = "lata/v1/auth")
//   claveManifiesto = HKDF-SHA256(secreto, salt = shareId, info = "lata/v1/manifest")
//   claveArchivo    = HKDF-SHA256(secreto, salt = sal del archivo, info = "lata/v1/file")
//   cuerpo          = nonce (12) || AES-256-GCM(datos) || etiqueta (16)

const te = new TextEncoder();
const td = new TextDecoder('utf-8', { fatal: true });

export const TAM_NONCE = 12;
export const TAM_ETIQUETA = 16;
export const SOBRECARGA = TAM_NONCE + TAM_ETIQUETA;
export const TAM_AAD_TROZO = 13 + 16 + 4 + 8 + 4 + 4 + 1; // 50 bytes
// Límites del manifiesto (sección 4). El tamaño de trozo decide cuánta memoria usa cada trabajador.
export const TROZO_MIN = 65536;
export const TROZO_MAX = 64 * 1048576;
export const ARCHIVOS_MAX = 1000000;
export const RUTA_MAX_BYTES = 4096;
export const MAX_U32 = 0xffffffff;
export const MAX_U64 = (1n << 64n) - 1n;
export const DIR_PARTES = '.lata-partes';

const INFO_ACCESO = te.encode('lata/v1/auth');
const INFO_MANIFIESTO = te.encode('lata/v1/manifest');
const INFO_ARCHIVO = te.encode('lata/v1/file');
const PREFIJO_MANIFIESTO = te.encode('lata/v1/manifest');
const PREFIJO_TROZO = te.encode('lata/v1/chunk');

/* ------------------------------------------------------------------ codificaciones */

export function hexABytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) throw new Error('hex no válido');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export function bytesAHex(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
  return s;
}

// base64url sin relleno → bytes. Lanza si hay caracteres ajenos o una longitud imposible.
export function b64uABytes(texto) {
  if (typeof texto !== 'string' || /[^A-Za-z0-9_-]/.test(texto) || texto.length % 4 === 1) throw new Error('b64u no válido');
  const bin = atob(texto.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (texto.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesAB64u(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* ------------------------------------------------------------------ enlace */

// <origen>/s/<shareId>#<secreto>. Devuelve null si el enlace no tiene la forma esperada.
export function leerEnlace(pathname, hash) {
  const m = /^\/s\/([A-Za-z0-9_-]{22})\/?$/.exec(pathname || '');
  const h = String(hash || '').replace(/^#/, '');
  if (!m || !/^[A-Za-z0-9_-]{43}$/.test(h)) return null;
  try {
    const shareId = b64uABytes(m[1]);
    const secreto = b64uABytes(h);
    if (shareId.length !== 16 || secreto.length !== 32) return null;
    return { shareIdTexto: m[1], shareId, secreto };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ números */

// Decimal canónico: solo dígitos, sin signo ni ceros a la izquierda (salvo "0").
export function esDecimalCanonico(s) {
  return typeof s === 'string' && /^(0|[1-9][0-9]*)$/.test(s);
}

// `version` es un u64 en texto decimal. Como número de JavaScript perdería bits por encima de 2^53.
export function versionABigInt(s) {
  if (!esDecimalCanonico(s) || s.length > 20) throw new Error('version no válida');
  const v = BigInt(s);
  if (v > MAX_U64) throw new Error('version fuera de rango');
  return v;
}

// Cociente y resto exactos para enteros seguros (evita el redondeo de la división en coma flotante).
function dividir(a, b) {
  let q = Math.floor(a / b);
  let r = a - q * b;
  while (r < 0) { q--; r += b; }
  while (r >= b) { q++; r -= b; }
  return [q, r];
}

function comprobarTamanos(tam, tamTrozo) {
  if (!Number.isSafeInteger(tam) || tam < 0) throw new Error('tamaño de archivo no válido');
  if (!Number.isInteger(tamTrozo) || tamTrozo < 1 || tamTrozo > MAX_U32) throw new Error('tamaño de trozo no válido');
}

// n = max(1, ceil(size / chunkSize)). Un archivo vacío tiene un trozo vacío.
export function numTrozos(tam, tamTrozo) {
  comprobarTamanos(tam, tamTrozo);
  if (tam === 0) return 1;
  const [q, r] = dividir(tam, tamTrozo);
  return q + (r > 0 ? 1 : 0);
}

// El trozo i cubre [i·chunkSize, min(size, (i+1)·chunkSize)). Devuelve null si i no existe.
export function rangoTrozo(tam, tamTrozo, i) {
  const n = numTrozos(tam, tamTrozo);
  if (!Number.isInteger(i) || i < 0 || i >= n) return null;
  const desplazamiento = i * tamTrozo;
  return { desplazamiento, longitud: Math.min(tamTrozo, tam - desplazamiento), esUltimo: i === n - 1 };
}

/* ------------------------------------------------------------------ claves */

const hkdf = (salt, info) => ({ name: 'HKDF', hash: 'SHA-256', salt, info });

// Clave base HKDF, no extraíble. Se puede enviar tal cual a los trabajadores con postMessage.
export function importarSecreto(secreto) {
  if (!(secreto instanceof Uint8Array) || secreto.length !== 32) throw new Error('el secreto debe medir 32 bytes');
  return crypto.subtle.importKey('raw', secreto, 'HKDF', false, ['deriveKey', 'deriveBits']);
}

function exigirShareId(shareId) {
  if (!(shareId instanceof Uint8Array) || shareId.length !== 16) throw new Error('shareId debe medir 16 bytes');
}

// La credencial de las peticiones (32 bytes). Va en `Authorization: Bearer <b64u>`.
export async function derivarClaveAcceso(base, shareId) {
  exigirShareId(shareId);
  return new Uint8Array(await crypto.subtle.deriveBits(hkdf(shareId, INFO_ACCESO), base, 256));
}

export function derivarClaveManifiesto(base, shareId, usos = ['decrypt']) {
  exigirShareId(shareId);
  return crypto.subtle.deriveKey(hkdf(shareId, INFO_MANIFIESTO), base, { name: 'AES-GCM', length: 256 }, false, usos);
}

export function derivarClaveArchivo(base, sal, usos = ['decrypt']) {
  if (!(sal instanceof Uint8Array) || sal.length !== 16) throw new Error('la sal debe medir 16 bytes');
  return crypto.subtle.deriveKey(hkdf(sal, INFO_ARCHIVO), base, { name: 'AES-GCM', length: 256 }, false, usos);
}

// Bytes en claro de las claves: solo para comprobar los vectores de prueba.
export async function derivarBitsManifiesto(base, shareId) {
  exigirShareId(shareId);
  return new Uint8Array(await crypto.subtle.deriveBits(hkdf(shareId, INFO_MANIFIESTO), base, 256));
}
export async function derivarBitsArchivo(base, sal) {
  return new Uint8Array(await crypto.subtle.deriveBits(hkdf(sal, INFO_ARCHIVO), base, 256));
}

/* ------------------------------------------------------------------ datos autenticados */

// AAD = "lata/v1/manifest" || shareId (16)
export function aadManifiesto(shareId) {
  exigirShareId(shareId);
  const aad = new Uint8Array(PREFIJO_MANIFIESTO.length + 16);
  aad.set(PREFIJO_MANIFIESTO, 0);
  aad.set(shareId, PREFIJO_MANIFIESTO.length);
  return aad;
}

// AAD = "lata/v1/chunk" || shareId (16) || fileId (u32) || version (u64) || chunkSize (u32) || i (u32) || esUltimo (1)
export function aadTrozo(shareId, fileId, version, tamTrozo, indice, esUltimo) {
  exigirShareId(shareId);
  if (typeof version !== 'bigint' || version < 0n || version > MAX_U64) throw new Error('version debe ser un BigInt de 64 bits');
  for (const [nombre, v] of [['fileId', fileId], ['chunkSize', tamTrozo], ['indice', indice]]) {
    if (!Number.isInteger(v) || v < 0 || v > MAX_U32) throw new Error(`${nombre} fuera de rango`);
  }
  const aad = new Uint8Array(TAM_AAD_TROZO);
  const dv = new DataView(aad.buffer);
  aad.set(PREFIJO_TROZO, 0);
  aad.set(shareId, 13);
  dv.setUint32(29, fileId, false);
  dv.setBigUint64(33, version, false);
  dv.setUint32(41, tamTrozo, false);
  dv.setUint32(45, indice, false);
  aad[49] = esUltimo ? 1 : 0;
  return aad;
}

/* ------------------------------------------------------------------ abrir y sellar */

// cuerpo: ArrayBuffer o Uint8Array con nonce || cifrado || etiqueta. Devuelve el ArrayBuffer en claro.
// Rechaza (OperationError) ante cualquier cambio en el cuerpo o en los datos autenticados.
export function abrir(clave, cuerpo, aad) {
  const vista = cuerpo instanceof Uint8Array ? cuerpo : new Uint8Array(cuerpo);
  if (vista.byteLength < SOBRECARGA) return Promise.reject(new Error('cuerpo más corto que nonce + etiqueta'));
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: vista.subarray(0, TAM_NONCE), additionalData: aad, tagLength: 128 },
    clave,
    vista.subarray(TAM_NONCE),
  );
}

// Solo para pruebas y vectores (nonce fijo): devuelve nonce || cifrado || etiqueta.
export async function sellar(clave, nonce, claro, aad) {
  if (nonce.length !== TAM_NONCE) throw new Error('el nonce debe medir 12 bytes');
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 }, clave, claro));
  const out = new Uint8Array(TAM_NONCE + ct.length);
  out.set(nonce, 0);
  out.set(ct, TAM_NONCE);
  return out;
}

/* ------------------------------------------------------------------ manifiesto */

export class ErrorManifiesto extends Error {
  constructor(mensaje) { super(mensaje); this.name = 'ErrorManifiesto'; }
}

// Comprueba la forma del JSON del manifiesto y lo devuelve normalizado.
// Las rutas NO se validan aquí: cada archivo se sanea por separado con sanearRuta().
export function validarManifiesto(m) {
  const mal = (t) => { throw new ErrorManifiesto('manifiesto no válido: ' + t); };
  if (!m || typeof m !== 'object' || Array.isArray(m)) mal('no es un objeto');
  if (m.v !== 1) mal('versión de protocolo no soportada');
  if (typeof m.name !== 'string') mal('name');
  if (!Number.isSafeInteger(m.manifestSeq) || m.manifestSeq < 0) mal('manifestSeq');
  if (!Number.isInteger(m.chunkSize) || m.chunkSize < TROZO_MIN || m.chunkSize > TROZO_MAX) mal('chunkSize');
  if (!Array.isArray(m.files)) mal('files');
  if (m.files.length > ARCHIVOS_MAX) mal('demasiados archivos');
  const vistos = new Set();
  const archivos = m.files.map((f, n) => {
    if (!f || typeof f !== 'object') mal(`files[${n}]`);
    if (!Number.isInteger(f.id) || f.id < 0 || f.id > MAX_U32) mal(`files[${n}].id`);
    if (vistos.has(f.id)) mal(`files[${n}].id repetido`);
    vistos.add(f.id);
    if (typeof f.path !== 'string') mal(`files[${n}].path`);
    if (bytesUtf8(f.path) > RUTA_MAX_BYTES) mal(`files[${n}].path demasiado larga`);
    if (!Number.isSafeInteger(f.size) || f.size < 0) mal(`files[${n}].size`);
    try { versionABigInt(f.version); } catch { mal(`files[${n}].version`); }
    let sal;
    try { sal = b64uABytes(f.sal); } catch { mal(`files[${n}].sal`); }
    if (sal.length !== 16) mal(`files[${n}].sal`);
    if (numTrozos(f.size, m.chunkSize) > MAX_U32) mal(`files[${n}]: demasiados trozos`);
    return { id: f.id, ruta: f.path, tam: f.size, version: f.version, sal };
  });
  return { v: 1, nombre: m.name, seq: m.manifestSeq, tamTrozo: m.chunkSize, archivos };
}

// cuerpo = nonce || AES-256-GCM(claveManifiesto, JSON, AAD = "lata/v1/manifest" || shareId) || etiqueta
export async function abrirManifiesto(clave, cuerpo, shareId) {
  let claro;
  try {
    claro = await abrir(clave, cuerpo, aadManifiesto(shareId));
  } catch {
    throw new ErrorManifiesto('el manifiesto no se pudo autenticar');
  }
  let json;
  try {
    json = JSON.parse(td.decode(claro));
  } catch {
    throw new ErrorManifiesto('el manifiesto no es JSON válido');
  }
  return validarManifiesto(json);
}

/* ------------------------------------------------------------------ rutas */

const RESERVADOS = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9]|lpt[0-9])$/i;
// Nombre corto de Windows (8.3): una ~ seguida de un dígito. «LATA-P~1» puede resolverse a «.lata-partes».
const NOMBRE_CORTO = /~[0-9]/;

// Bytes que ocupa un texto en UTF-8 (sin reservar memoria si no hace falta).
export function bytesUtf8(texto) {
  if (texto.length * 3 <= RUTA_MAX_BYTES) return texto.length; // cota suficiente: no puede pasarse
  return te.encode(texto).length;
}
// Caracteres de control C0, DEL y C1.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

// Valida la ruta del manifiesto (sección 4) y sanea cada segmento antes de escribir (sección 8).
// Devuelve { ok: true, segmentos } o { ok: false, motivo } con un texto para la persona.
export function sanearRuta(ruta) {
  const no = (motivo) => ({ ok: false, motivo });
  if (typeof ruta !== 'string' || ruta === '') return no('nombre vacío');
  if (ruta.length > RUTA_MAX_BYTES || bytesUtf8(ruta) > RUTA_MAX_BYTES) return no('ruta demasiado larga');
  if (ruta.includes('\\')) return no('contiene una barra invertida');
  if (CONTROL.test(ruta)) return no('contiene caracteres de control');
  const segmentos = [];
  for (const crudo of ruta.split('/')) {
    if (crudo === '') return no('tiene un tramo vacío');
    if (crudo === '.' || crudo === '..') return no('intenta salir de la carpeta');
    const s = crudo.replace(/[. ]+$/, ''); // Windows no admite puntos ni espacios finales
    if (s === '') return no('tiene un tramo hecho solo de puntos o espacios');
    if (s.length > 255) return no('tiene un nombre demasiado largo');
    const base = s.split('.')[0].replace(/ +$/, '');
    if (RESERVADOS.test(base)) return no('usa un nombre reservado de Windows');
    if (NOMBRE_CORTO.test(s)) return no('tiene forma de nombre corto de Windows');
    segmentos.push(s);
  }
  if (segmentos[0].toLowerCase() === DIR_PARTES) return no('usa el nombre de la carpeta de trabajo');
  return { ok: true, segmentos };
}

// Nombre para una subcarpeta nueva a partir del nombre de la compartición (que viene del emisor).
export function sanearNombreCarpeta(nombre) {
  let s = String(nombre === undefined || nombre === null ? '' : nombre)
    .replace(/[\u0000-\u001f\u007f-\u009f<>:"/\\|?*~]/g, ' ').replace(/\s+/g, ' ').trim()
    .slice(0, 80).replace(/[. ]+$/, '');
  if (s === '' || !sanearRuta(s).ok) s = 'Lata';
  return s;
}

// Sanea todas las rutas de un manifiesto y detecta choques entre ellas (mismo nombre tras sanear,
// o un archivo que ocupa el sitio de una carpeta). La comparación ignora mayúsculas porque Windows
// y macOS lo hacen. Devuelve un Map id → { ok, segmentos | motivo }.
export function sanearRutas(archivos) {
  const res = new Map();
  const archivosVistos = new Set();
  const carpetas = new Set();
  const clave = (segs) => segs.join('/').toLowerCase();
  for (const a of archivos) {
    const r = sanearRuta(a.ruta);
    if (r.ok) {
      for (let i = 1; i < r.segmentos.length; i++) carpetas.add(clave(r.segmentos.slice(0, i)));
    }
    res.set(a.id, r);
  }
  for (const a of archivos) {
    const r = res.get(a.id);
    if (!r.ok) continue;
    const k = clave(r.segmentos);
    let choque = '';
    if (archivosVistos.has(k)) choque = 'su nombre coincide con el de otro archivo';
    else if (carpetas.has(k)) choque = 'su nombre coincide con el de una carpeta';
    else {
      for (let i = 1; i < r.segmentos.length && !choque; i++) {
        if (archivosVistos.has(clave(r.segmentos.slice(0, i)))) choque = 'una de sus carpetas coincide con un archivo';
      }
    }
    if (choque) res.set(a.id, { ok: false, motivo: choque });
    else archivosVistos.add(k);
  }
  return res;
}
