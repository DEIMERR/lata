// Cliente de la API del motor (docs/PROTOCOLO.md, sección 3). Funciona en la página y en los trabajadores.
//
// Cada fallo se clasifica en una `clase`, que es lo único que mira quien llama para decidir qué hacer:
//   fatal       401, 421                      detenerse: enlace no válido o revocado (en el modo fijo, un 421
//                                             no detiene nada: se pregunta al punto de encuentro dónde está el motor)
//   manifiesto  404                           volver a pedir el manifiesto
//   version     409                           volver a pedir el manifiesto y rebajar ese archivo
//   espera      429, 503 con código conocido  esperar `espera` segundos (Retry-After) y reintentar
//   red         corte, 5xx sin código, cuerpo cortado, sin datos durante demasiado tiempo → espera progresiva
//               (con código «protocolo» si el motor responde un 4xx que no está en la tabla, como 400 o
//               405: se reintenta igual, pero se enseña como un fallo distinto porque delata un error)
//   integridad  el cuerpo no mide lo que dice el manifiesto (o no se autentica) → se descarta y se repite

import { SOBRECARGA } from './wire.js';

export const SIN_DATOS_MS = 45000; // si no llega nada en 45 s, se corta la petición y se reintenta
const MANIFIESTO_MAX = 64 * 1048576 + SOBRECARGA; // sección 4: como mucho 64 MiB de manifiesto

export class ErrorApi extends Error {
  constructor(clase, codigo, extra = {}) {
    super(`${clase}: ${codigo}`);
    this.name = 'ErrorApi';
    this.clase = clase;
    this.codigo = codigo;
    this.estado = extra.estado || 0;
    this.espera = extra.espera || 0; // segundos
  }
}

export const esCancelacion = (e) => !!e && e.name === 'AbortError';

// Retry-After: segundos o fecha HTTP. Se acota para que una cabecera absurda no deje la página colgada.
export function leerRetryAfter(valor, porDefecto = 5, ahora = Date.now()) {
  let s = NaN;
  if (typeof valor === 'string' && /^\s*\d+\s*$/.test(valor)) s = Number(valor);
  else if (typeof valor === 'string' && /^\s*[A-Za-z]{3},? /.test(valor)) { // fecha HTTP: «Fri, 20 Nov 2026 12:00:30 GMT»
    const t = Date.parse(valor);
    if (!Number.isNaN(t)) s = Math.ceil((t - ahora) / 1000);
  }
  if (!Number.isFinite(s)) s = porDefecto;
  return Math.max(1, Math.min(300, s));
}

// Traduce un estado HTTP y el código del cuerpo JSON a la clase de la tabla de errores.
export function clasificar(estado, codigo, retryAfter) {
  const extra = { estado };
  if (estado === 401) return new ErrorApi('fatal', 'unauthorized', extra);
  if (estado === 421) return new ErrorApi('fatal', 'bad_host', extra);
  if (estado === 404) return new ErrorApi('manifiesto', 'not_found', extra);
  if (estado === 409) return new ErrorApi('version', 'version_changed', extra);
  if (estado === 429) return new ErrorApi('espera', 'rate_limited', { estado, espera: leerRetryAfter(retryAfter) });
  if (estado === 503 && (codigo === 'paused' || codigo === 'source_unavailable')) {
    return new ErrorApi('espera', codigo, { estado, espera: leerRetryAfter(retryAfter) });
  }
  if (estado >= 500) return new ErrorApi('red', 'http_5xx', extra);
  if (estado >= 400) return new ErrorApi('red', 'protocolo', extra);
  return new ErrorApi('red', 'http_inesperado', extra);
}

async function errorDeRespuesta(res) {
  let codigo = '';
  try {
    const texto = (await res.text()).slice(0, 4096);
    const j = JSON.parse(texto);
    if (j && typeof j.error === 'string') codigo = j.error;
  } catch { /* cuerpo vacío o no JSON: basta con el estado */ }
  return clasificar(res.status, codigo, res.headers.get('Retry-After'));
}

// Vigía de inactividad: corta la petición si pasa `ms` sin llamar a rearmar().
function vigia(senalExterna, ms) {
  const ctrl = new AbortController();
  let disparado = false;
  let t = 0;
  const cortar = () => ctrl.abort();
  if (senalExterna) {
    if (senalExterna.aborted) ctrl.abort();
    else senalExterna.addEventListener('abort', cortar, { once: true });
  }
  const rearmar = () => {
    clearTimeout(t);
    t = setTimeout(() => { disparado = true; ctrl.abort(); }, ms);
  };
  rearmar();
  return {
    signal: ctrl.signal,
    rearmar,
    fin() { clearTimeout(t); if (senalExterna) senalExterna.removeEventListener('abort', cortar); },
    get disparado() { return disparado; },
  };
}

// `origen`: '' en el modo clásico (mismo origen que la página). En el modo fijo (sección 10) es el
// origen del motor que dice el puntero, y las peticiones van entre orígenes; puede cambiar en caliente.
export function crearApi({ shareIdTexto, credencial, sinDatosMs = SIN_DATOS_MS, origen = '' }) {
  let prefijo = `${origen}/api/v1/s/${shareIdTexto}`;
  const cabeceras = { Authorization: `Bearer ${credencial}` };
  const base = { cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' };

  // Hace una petición y entrega la respuesta a `leer`. Convierte cualquier fallo en ErrorApi,
  // salvo la cancelación pedida por quien llama, que sale como AbortError.
  async function pedir(ruta, opciones, senal, leer) {
    const v = vigia(senal, sinDatosMs);
    try {
      const res = await fetch(prefijo + ruta, { ...base, ...opciones, headers: { ...cabeceras, ...(opciones.headers || {}) }, signal: v.signal });
      v.rearmar();
      return await leer(res, v);
    } catch (e) {
      if (e instanceof ErrorApi) throw e;
      if (v.disparado) throw new ErrorApi('red', 'sin_datos');
      if (senal && senal.aborted) throw new DOMException('Cancelado', 'AbortError');
      throw new ErrorApi('red', 'conexion');
    } finally {
      v.fin();
    }
  }

  // Lee un cuerpo de tamaño conocido en un búfer reservado de antemano (una sola copia en memoria).
  async function leerExacto(res, v, esperado, alRecibir) {
    const cl = res.headers.get('Content-Length');
    if (cl !== null && Number(cl) !== esperado) {
      try { await res.body.cancel(); } catch { /* da igual */ }
      throw new ErrorApi('integridad', 'longitud');
    }
    const buf = new Uint8Array(esperado);
    const lector = res.body.getReader();
    let n = 0;
    for (;;) {
      const { done, value } = await lector.read();
      if (done) break;
      if (n + value.length > esperado) {
        try { await lector.cancel(); } catch { /* da igual */ }
        throw new ErrorApi('integridad', 'longitud');
      }
      buf.set(value, n);
      n += value.length;
      v.rearmar();
      if (alRecibir) alRecibir(value.length);
    }
    if (n !== esperado) throw new ErrorApi('red', 'cortado');
    return buf.buffer;
  }

  async function leerTodo(res, v, maximo) {
    const lector = res.body.getReader();
    const piezas = [];
    let n = 0;
    for (;;) {
      const { done, value } = await lector.read();
      if (done) break;
      n += value.length;
      if (n > maximo) {
        try { await lector.cancel(); } catch { /* da igual */ }
        throw new ErrorApi('red', 'demasiado_grande');
      }
      piezas.push(value);
      v.rearmar();
    }
    const out = new Uint8Array(n);
    let p = 0;
    for (const x of piezas) { out.set(x, p); p += x.length; }
    return out;
  }

  return {
    // El motor está ahora en otro origen: las peticiones siguientes van allí. Las que estén en curso
    // las corta quien llama.
    cambiarOrigen(nuevo) { prefijo = `${nuevo}/api/v1/s/${shareIdTexto}`; },

    // GET <api>/manifest → { cuerpo: Uint8Array cifrado, seq: número de la cabecera X-Lata-Seq o null }
    manifiesto(senal) {
      return pedir('/manifest', {}, senal, async (res, v) => {
        if (res.status !== 200) throw await errorDeRespuesta(res);
        const seq = Number(res.headers.get('X-Lata-Seq'));
        return { cuerpo: await leerTodo(res, v, MANIFIESTO_MAX), seq: Number.isSafeInteger(seq) ? seq : null };
      });
    },

    // GET <api>/status → { state, manifestSeq }
    estado(senal) {
      return pedir('/status', {}, senal, async (res, v) => {
        if (res.status !== 200) throw await errorDeRespuesta(res);
        let j;
        try { j = JSON.parse(new TextDecoder().decode(await leerTodo(res, v, 65536))); } catch (e) {
          if (e instanceof ErrorApi) throw e;
          throw new ErrorApi('red', 'respuesta_no_valida');
        }
        if (!j || !['active', 'paused', 'source_unavailable'].includes(j.state)) throw new ErrorApi('red', 'respuesta_no_valida');
        return { state: j.state, manifestSeq: Number.isSafeInteger(j.manifestSeq) ? j.manifestSeq : null };
      });
    },

    // GET <api>/f/<fileId>/<version>/<i> → ArrayBuffer de exactamente longitud + 28 bytes (nonce || cifrado || etiqueta).
    // `longitud` sale del manifiesto, nunca de la respuesta.
    trozo(fileId, version, indice, longitud, senal, alRecibir) {
      return pedir(`/f/${fileId}/${version}/${indice}`, {}, senal, async (res, v) => {
        if (res.status !== 200) throw await errorDeRespuesta(res);
        return leerExacto(res, v, longitud + SOBRECARGA, alRecibir);
      });
    },

    // POST <api>/progress → 204
    avance(informe, senal) {
      const cuerpo = JSON.stringify(informe);
      return pedir('/progress', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: cuerpo, keepalive: cuerpo.length < 4096 }, senal, async (res) => {
        if (res.status !== 204) throw await errorDeRespuesta(res);
        return true;
      });
    },
  };
}

// Espera progresiva de la sección 3: 1 s, 2 s, 4 s… hasta 30 s.
export function esperaProgresiva(intento) {
  return Math.min(30, 2 ** Math.max(0, Math.min(10, intento - 1)));
}
