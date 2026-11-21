// Escritura en la carpeta elegida (docs/PROTOCOLO.md, sección 8), detrás de una interfaz para poder
// cambiar de estrategia cuando lleguen las mediciones en disco real.
//
// Interfaz que usa la sesión y la descarga (cualquier otra estrategia debe ofrecer lo mismo):
//
//   geometria(tam)               → { nTrozos, nUnidades, ensambla, unidad(k) → { primer, n, bytes } }
//                                  Una «unidad» es lo que se abre, se escribe y se cierra de una vez.
//   cargarRegistro()             → lee el registro en disco de esta compartición, si existe (solo lectura)
//   revisar(archivos)            → Map id → estado de cada archivo en la carpeta. SOLO LEE: no crea ni borra nada.
//   preparar(archivos, estados)  → apunta en el registro lo que la página va a crear y, después, limpia sus restos
//   abrirUnidad(archivo, k)      → { escribir(posicion, ArrayBuffer), cerrar(), abortar() }
//   ensamblar(archivo, avance)   → une las unidades en el archivo final, si geometria().ensambla
//   descartar(archivo)           → borra el trabajo en curso de ese archivo
//   restos()                     → partes a medias que quedan; si no queda ninguna, quita el subdirectorio propio
//
// Cada `archivo` necesita: id, version (texto), segmentos (ruta ya saneada) y tam.
//
// Estrategia de este archivo, «partes»:
//   - Archivos de hasta 8 trozos: una sola unidad, escrita directamente como archivo final.
//   - Archivos mayores: partes de 8 trozos en .lata-partes/<shareId>/<fileId>-<version>/<k>.parte, que
//     al final se unen en el archivo final con un solo flujo. El nivel <shareId> permite descargar dos
//     comparticiones en la misma carpeta: cada una lista, limpia y borra solo su propio subdirectorio,
//     y .lata-partes se quita únicamente cuando queda vacío.
//
// REGLA DE ORO: la página nunca borra ni reemplaza un archivo que no creó ella para esta compartición.
// Para saber qué es suyo lleva un registro en disco, .lata-partes/<shareId>/creados.json, que se escribe
// ANTES de crear nada:
//
//   { v: 1, share, seq, destino, creados: { "<ruta final>": "<fileId>-<version>" },
//     partes: { "<fileId>-<version>": [k, …] }, adoptados: ["<ruta final>", …] }
//
//   seq        mayor manifestSeq visto (protección contra un manifiesto antiguo; sobrevive a un cambio de origen)
//   destino    subcarpeta donde se guarda todo ('' = la carpeta elegida); recuerda la decisión tomada
//   creados    archivos finales que la página tiene apuntados como suyos, con la versión con que los crea
//   partes     partes que la página escribe ella misma (las que encuentra hechas sin estar aquí son «adoptadas»)
//   adoptados  archivos finales que se montan con alguna parte adoptada: nunca se etiquetan «Verificado»
//   temporalesAjenos  rutas que ya tenían un <nombre>.crswap al lado cuando la página las hizo suyas: ese
//              temporal no es de la página y no se borra
//
// Lo aprendido en el prototipo de escritura, que este código respeta:
//   1. getFileHandle({create:true}) deja un archivo de 0 bytes que sobrevive a un cierre brusco:
//      «existe» nunca significa «completo»; solo cuenta el tamaño exacto esperado.
//   2. <nombre>.crswap aparece en los listados mientras hay un flujo abierto: se ignora, y solo se
//      limpia junto a un archivo que es de la página.
//   3. Nada de lo escrito sobrevive si la pestaña muere antes de close(): una unidad cuenta solo
//      cuando close() ha terminado.
//   4. keepExistingData:true copia el archivo entero: no se usa nunca.
//   5. Para ensamblar se pasa cada parte entera al navegador con write(File), sin leerla desde JS.

import { DIR_PARTES, numTrozos, sanearNombreCarpeta, sanearRuta } from './wire.js';

export const TROZOS_POR_PARTE = 8;
export const ARCHIVO_REGISTRO = 'creados.json';
const REGISTRO_MAX = 512 * 1048576;

// Fallo al escribir en la carpeta del receptor (disco lleno, permiso perdido, carpeta desaparecida…).
export class ErrorDisco extends Error {
  constructor(causa, donde) {
    super(`${donde}: ${(causa && causa.name) || 'Error'}${causa && causa.message ? ' — ' + causa.message : ''}`);
    this.name = 'ErrorDisco';
    this.causa = (causa && causa.name) || 'Error';
    this.donde = donde;
  }
}

// Ese archivo en concreto no se puede crear (nombre no admitido, sitio ocupado o sin apuntar como propio).
export class ErrorNombre extends Error {
  constructor(causa) {
    super('no se puede crear: ' + ((causa && causa.message) || ''));
    this.name = 'ErrorNombre';
  }
}

// Faltan partes (o no miden lo esperado) al ir a ensamblar: hay que volver a bajarlas.
export class ErrorPartes extends Error {
  constructor(malas) {
    super('partes incompletas: ' + malas.join(', '));
    this.name = 'ErrorPartes';
    this.malas = malas;
  }
}

const deDisco = (e, donde) => (e instanceof ErrorDisco || e instanceof ErrorNombre || e instanceof ErrorPartes ? e : new ErrorDisco(e, donde));
// Al abrir por nombre, TypeError = nombre no admitido; TypeMismatchError = ya hay algo de otro tipo ahí.
const alAbrir = (e, donde) => (e && (e.name === 'TypeError' || e.name === 'TypeMismatchError') ? new ErrorNombre(e) : deDisco(e, donde));

async function listar(dir) {
  const m = new Map();
  for await (const [nombre, h] of dir.entries()) m.set(nombre, h);
  return m;
}

async function enLotes(items, n, fn) {
  for (let i = 0; i < items.length; i += n) await Promise.all(items.slice(i, i + n).map(fn));
}

async function borrar(dir, nombre, recursivo = false) {
  try {
    await dir.removeEntry(nombre, { recursive: recursivo });
    return true;
  } catch {
    return false; // ya no está, o está en uso: no cuenta en ningún caso
  }
}

class Unidad {
  constructor(dir, nombre, fh, flujo, bytes) {
    this.dir = dir; this.nombre = nombre; this.fh = fh; this.flujo = flujo; this.bytes = bytes;
    this.cierre = null;
    this.abortada = false;
  }

  // Escribe un trozo en su posición. Los trozos pueden llegar en cualquier orden.
  async escribir(posicion, datos) {
    if (datos.byteLength === 0) return;
    try {
      await this.flujo.write({ type: 'write', position: posicion, data: datos });
    } catch (e) { throw deDisco(e, 'escribir'); }
  }

  // Cierra y comprueba el tamaño. Solo después de esto la unidad cuenta como descargada.
  cerrar() {
    this.cierre = (async () => {
      try {
        await this.flujo.close();
        const real = (await this.fh.getFile()).size;
        if (real !== this.bytes) throw new ErrorDisco({ name: 'TamanoIncorrecto', message: `${real} en vez de ${this.bytes}` }, 'cerrar');
      } catch (e) { throw deDisco(e, 'cerrar'); }
    })();
    return this.cierre;
  }

  // Descarta lo escrito y quita el archivo de 0 bytes que dejó getFileHandle (lo creó la página).
  // Si había un cierre en marcha, espera a que termine para no cruzarse con él.
  async abortar() {
    if (this.abortada) return;
    this.abortada = true;
    if (this.cierre) await this.cierre.catch(() => {});
    else try { await this.flujo.abort(); } catch { /* ya estaba cerrado o roto */ }
    await borrar(this.dir, this.nombre);
  }
}

function registroVacio(share) {
  return { v: 1, share, seq: 0, destino: '', creados: new Map(), partes: new Map(), adoptados: new Set(), temporalesAjenos: new Set() };
}

// Convierte el JSON leído del disco en el registro en memoria. Devuelve null si no tiene la forma esperada:
// en ese caso se trata como si no hubiera registro (nada es de la página, que es el lado seguro).
function leerRegistroJson(texto, share) {
  let j;
  try { j = JSON.parse(texto); } catch { return null; }
  if (!j || typeof j !== 'object' || j.v !== 1 || j.share !== share) return null;
  const r = registroVacio(share);
  if (Number.isSafeInteger(j.seq) && j.seq >= 0) r.seq = j.seq;
  if (typeof j.destino === 'string' && j.destino !== '') {
    const s = sanearRuta(j.destino);
    if (!s.ok || s.segmentos.length !== 1 || s.segmentos[0] !== j.destino) return null;
    r.destino = j.destino;
  }
  if (j.creados && typeof j.creados === 'object' && !Array.isArray(j.creados)) {
    for (const [k, v] of Object.entries(j.creados)) if (typeof v === 'string') r.creados.set(k, v);
  }
  if (j.partes && typeof j.partes === 'object' && !Array.isArray(j.partes)) {
    for (const [k, v] of Object.entries(j.partes)) {
      if (Array.isArray(v)) r.partes.set(k, new Set(v.filter((x) => Number.isInteger(x) && x >= 0)));
    }
  }
  if (Array.isArray(j.adoptados)) for (const k of j.adoptados) if (typeof k === 'string') r.adoptados.add(k);
  if (Array.isArray(j.temporalesAjenos)) for (const k of j.temporalesAjenos) if (typeof k === 'string') r.temporalesAjenos.add(k);
  return r;
}

export class EscritorPartes {
  constructor(raiz, tamTrozo, shareIdTexto) {
    this.raiz = raiz;           // FileSystemDirectoryHandle con permiso de lectura y escritura
    this.tamTrozo = tamTrozo;
    this.share = shareIdTexto;  // nombre del subdirectorio propio dentro de .lata-partes
    this.dirs = new Map();      // "a/b/c" → Promise<FileSystemDirectoryHandle>
    this.registro = registroVacio(shareIdTexto);
    this.registroEnDisco = false;
    this.reemplazar = new Set(); // rutas que la persona ha permitido reemplazar (pasan al registro en preparar)
    this.escritura = Promise.resolve();
    this.pendiente = null;
  }

  geometria(tam) {
    const cs = this.tamTrozo;
    const nTrozos = numTrozos(tam, cs);
    const ensambla = nTrozos > TROZOS_POR_PARTE;
    const nUnidades = ensambla ? Math.ceil(nTrozos / TROZOS_POR_PARTE) : 1;
    return {
      nTrozos, nUnidades, ensambla,
      unidad(k) {
        if (!ensambla) return { primer: 0, n: nTrozos, bytes: tam };
        const primer = k * TROZOS_POR_PARTE;
        const n = Math.min(TROZOS_POR_PARTE, nTrozos - primer);
        const desde = primer * cs;
        return { primer, n, bytes: Math.min(tam, desde + n * cs) - desde };
      },
    };
  }

  /* ---------------------------------------------------------------- carpetas */

  // Carpeta (creándola si hace falta). Se recuerda para no repetir la consulta.
  dir(segs) {
    const k = segs.join('/');
    let p = this.dirs.get(k);
    if (!p) {
      p = (async () => {
        let h = segs.length > 1 ? await this.dir(segs.slice(0, -1)) : this.raiz;
        if (segs.length) h = await h.getDirectoryHandle(segs[segs.length - 1], { create: true });
        return h;
      })();
      this.dirs.set(k, p);
      p.catch(() => this.dirs.delete(k));
    }
    return p;
  }

  async dirSiExiste(segs) {
    let h = this.raiz;
    for (const s of segs) {
      try { h = await h.getDirectoryHandle(s); } catch (e) {
        if (e && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError' || e.name === 'TypeError')) return null;
        throw e;
      }
    }
    return h;
  }

  // Dónde va cada archivo final: dentro de la subcarpeta de destino, si se eligió una.
  rutaFinal(a) { return this.registro.destino ? [this.registro.destino, ...a.segmentos] : a.segmentos; }
  clave(a) { return this.rutaFinal(a).join('/'); }
  nombrePartes(a) { return `${a.id}-${a.version}`; }
  dirPartes(a) { return this.dir([DIR_PARTES, this.share, this.nombrePartes(a)]); }

  olvidarDirsDePartes() {
    for (const k of [...this.dirs.keys()]) if (k === DIR_PARTES || k.startsWith(DIR_PARTES + '/')) this.dirs.delete(k);
  }

  // Otra compartición que termina en la misma carpeta puede quitar .lata-partes si en ese instante
  // estaba vacío. Si la carpeta recordada ya no existe, se olvida y se vuelve a crear una vez.
  async enPropio(segs, fn) {
    try {
      return await fn(await this.dir(segs));
    } catch (e) {
      if (!e || e.name !== 'NotFoundError') throw e;
      this.olvidarDirsDePartes();
      return fn(await this.dir(segs));
    }
  }

  /* ---------------------------------------------------------------- registro en disco */

  // Lee creados.json si existe. No crea nada. Un registro ilegible se ignora.
  async cargarRegistro() {
    this.registro = registroVacio(this.share);
    this.registroEnDisco = false;
    try {
      const d = await this.dirSiExiste([DIR_PARTES, this.share]);
      if (!d) return this.registro;
      let f;
      try { f = await (await d.getFileHandle(ARCHIVO_REGISTRO)).getFile(); } catch (e) {
        if (e && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError')) return this.registro;
        throw e;
      }
      if (f.size > REGISTRO_MAX) return this.registro;
      const r = leerRegistroJson(await f.text(), this.share);
      if (r) { this.registro = r; this.registroEnDisco = true; }
    } catch (e) { throw deDisco(e, 'leer el registro'); }
    return this.registro;
  }

  // Escribe el registro. Las escrituras van en fila y se agrupan: quien espera esta promesa tiene la
  // garantía de que lo que apuntó antes de llamar ya está en disco cuando se resuelve.
  guardarRegistro() {
    if (!this.pendiente) {
      const p = this.escritura.catch(() => {}).then(async () => {
        this.pendiente = null;
        const r = this.registro;
        const texto = JSON.stringify({
          v: 1, share: this.share, seq: r.seq, destino: r.destino,
          creados: Object.fromEntries(r.creados),
          partes: Object.fromEntries([...r.partes].map(([k, v]) => [k, [...v].sort((x, y) => x - y)])),
          adoptados: [...r.adoptados],
          temporalesAjenos: [...r.temporalesAjenos],
        });
        try {
          await this.enPropio([DIR_PARTES, this.share], async (d) => {
            const flujo = await (await d.getFileHandle(ARCHIVO_REGISTRO, { create: true })).createWritable();
            await flujo.write(texto);
            await flujo.close();
          });
          this.registroEnDisco = true;
        } catch (e) { throw deDisco(e, 'guardar el registro'); }
      });
      this.pendiente = p;
      this.escritura = p;
    }
    return this.pendiente;
  }

  // Apunta el mayor manifestSeq visto. Solo toca el disco si el registro ya existe.
  anotarSeq(seq) {
    if (!(seq > this.registro.seq)) return;
    this.registro.seq = seq;
    if (this.registroEnDisco) this.guardarRegistro().catch(() => {});
  }

  // Nombre de subcarpeta nueva para guardar la compartición sin tocar lo que ya hay: el nombre de la
  // compartición saneado y, si ya existe algo con ese nombre, con un número detrás.
  async proponerSubcarpeta(nombre) {
    const base = sanearNombreCarpeta(nombre);
    let hay;
    try { hay = new Set([...(await listar(this.raiz)).keys()].map((n) => n.toLowerCase())); } catch (e) { throw deDisco(e, 'leer la carpeta'); }
    let candidato = base;
    for (let n = 2; hay.has(candidato.toLowerCase()); n++) candidato = `${base} ${n}`;
    return candidato;
  }

  fijarDestino(nombre) { this.registro.destino = nombre; this.dirs.clear(); }

  // ¿Hay en la carpeta elegida una subcarpeta con ese nombre (un solo tramo válido)? Solo lee.
  async existeCarpeta(nombre) {
    const s = sanearRuta(nombre);
    if (!s.ok || s.segmentos.length !== 1 || s.segmentos[0] !== nombre) return false;
    try { return !!(await this.dirSiExiste([nombre])); } catch { return false; }
  }
  permitirReemplazo(claves) { for (const k of claves) this.reemplazar.add(k); }

  /* ---------------------------------------------------------------- revisar (solo lectura) */

  // Mira qué hay en la carpeta para cada archivo, SIN crear ni borrar nada. Estados:
  //   ausente             no hay nada en esa ruta
  //   propio              lo creó la página con esta versión y mide lo esperado → completo y verificado
  //   propio-incompleto   es de la página pero no vale (a medias, otra versión, o permitido reemplazar)
  //   ajeno-igual         ya estaba y mide lo mismo → se da por presente, «Ya estaba»
  //   colision            ya estaba y mide otra cosa → hay que preguntar antes de tocarlo
  //   ocupado             en esa ruta hay una carpeta → ese archivo no se puede guardar
  // Además: hechas (partes cerradas con el tamaño exacto), adoptado (alguna parte no la escribió la
  // página), tamDisco y temporal (hay un <nombre>.crswap al lado).
  async revisar(archivos) {
    this.dirs.clear();
    const res = new Map();
    const reg = this.registro;
    try {
      const grupos = new Map();
      for (const a of archivos) {
        const segs = this.rutaFinal(a).slice(0, -1);
        const k = segs.join('/');
        if (!grupos.has(k)) grupos.set(k, { segs, lista: [] });
        grupos.get(k).lista.push(a);
      }
      for (const { segs, lista } of grupos.values()) {
        const d = await this.dirSiExiste(segs);
        const entradas = d ? await listar(d) : new Map();
        const esperados = new Set(lista.map((a) => a.segmentos[a.segmentos.length - 1]));
        await enLotes(lista, 8, async (a) => {
          const nombre = a.segmentos[a.segmentos.length - 1];
          const clave = this.clave(a);
          const h = entradas.get(nombre);
          const r = { estado: 'ausente', completo: false, verificado: false, hechas: new Set(), adoptado: reg.adoptados.has(clave), tamDisco: null, temporal: false, hayTemporal: false };
          res.set(a.id, r);
          const marca = reg.creados.get(clave);
          const propio = marca !== undefined || this.reemplazar.has(clave);
          r.hayTemporal = entradas.has(nombre + '.crswap') && !esperados.has(nombre + '.crswap');
          // Solo es un resto de la página si la ruta ya constaba como suya y el temporal no estaba de antes.
          r.temporal = r.hayTemporal && marca !== undefined && !reg.temporalesAjenos.has(clave);
          if (!h) return;
          if (h.kind !== 'file') { r.estado = 'ocupado'; return; }
          let real = -1;
          try { real = (await h.getFile()).size; } catch { return; /* desapareció mientras se listaba */ }
          r.tamDisco = real;
          if (propio) {
            // Un archivo vacío mide lo esperado desde que se crea: solo vale si se completa en esta sesión.
            if (real === a.tam && a.tam > 0 && marca === this.nombrePartes(a)) {
              r.estado = 'propio';
              r.completo = true;
              r.verificado = !r.adoptado;
            } else r.estado = 'propio-incompleto';
          } else if (real === a.tam) {
            r.estado = 'ajeno-igual';
            r.completo = true;
          } else r.estado = 'colision';
        });
      }

      // Partes: solo el subdirectorio de esta compartición.
      const rp = await this.dirSiExiste([DIR_PARTES, this.share]);
      if (rp) {
        const entradas = await listar(rp);
        for (const a of archivos) {
          const r = res.get(a.id);
          const g = this.geometria(a.tam);
          if (!g.ensambla || r.completo) continue;
          const h = entradas.get(this.nombrePartes(a));
          if (!h || h.kind !== 'directory') continue;
          const propias = reg.partes.get(this.nombrePartes(a));
          for (const [n2, h2] of await listar(h)) {
            const m = /^(0|[1-9][0-9]*)\.parte$/.exec(n2);
            const k = m ? Number(m[1]) : -1;
            if (!m || h2.kind !== 'file' || k >= g.nUnidades) continue;
            let vale = false;
            try { vale = (await h2.getFile()).size === g.unidad(k).bytes; } catch { /* no cuenta */ }
            if (!vale) continue;
            r.hechas.add(k);
            if (!propias || !propias.has(k)) r.adoptado = true; // tiene el tamaño, pero no consta que la escribiera la página
          }
        }
      }
    } catch (e) { throw deDisco(e, 'revisar la carpeta'); }
    return res;
  }

  /* ---------------------------------------------------------------- preparar (apunta y limpia) */

  // Para los archivos que se van a descargar: primero apunta en el registro (y lo guarda) lo que la
  // página va a crear; solo después limpia sus propios restos. Los archivos ajenos no se tocan nunca.
  // `estados` es lo que devolvió revisar() para esos mismos archivos.
  // op.todos: si se pasa (revisión completa), la lista de todos los archivos válidos del manifiesto; lo
  // que haya en el subdirectorio propio y no corresponda a ninguno se borra.
  async preparar(archivos, estados, op = {}) {
    const reg = this.registro;
    const propios = [];
    for (const a of archivos) {
      const r = estados.get(a.id);
      if (!r || r.estado === 'ajeno-igual' || r.estado === 'ocupado' || r.estado === 'colision') continue;
      const clave = this.clave(a);
      if (!reg.creados.has(clave) && r.hayTemporal) reg.temporalesAjenos.add(clave);
      reg.creados.set(clave, this.nombrePartes(a));
      this.reemplazar.delete(clave);
      if (r.adoptado) reg.adoptados.add(clave); else reg.adoptados.delete(clave);
      const g = this.geometria(a.tam);
      if (g.ensambla && !r.completo) {
        // Son de la página las partes que ya tenía apuntadas y las que aún no existen (las creará ella).
        const antes = reg.partes.get(this.nombrePartes(a)) || new Set();
        const suyas = new Set();
        for (let k = 0; k < g.nUnidades; k++) if (antes.has(k) || !r.hechas.has(k)) suyas.add(k);
        reg.partes.set(this.nombrePartes(a), suyas);
      }
      propios.push(a);
    }
    if (!propios.length && !this.registroEnDisco) return;
    await this.guardarRegistro();

    // A partir de aquí, limpieza de restos PROPIOS (ya consta en disco que lo son).
    try {
      for (const a of propios) {
        const r = estados.get(a.id);
        if (r.estado !== 'propio-incompleto' && !r.temporal) continue;
        const d = await this.dirSiExiste(this.rutaFinal(a).slice(0, -1));
        if (!d) continue;
        const nombre = a.segmentos[a.segmentos.length - 1];
        if (r.estado === 'propio-incompleto') await borrar(d, nombre);
        if (r.temporal) await borrar(d, nombre + '.crswap');
      }
      await this.limpiarSubdirectorio(archivos, estados, op.todos);
    } catch (e) { throw deDisco(e, 'limpiar restos'); }
  }

  // Dentro del subdirectorio propio: fuera lo que no sea el registro o partes válidas de archivos en curso.
  async limpiarSubdirectorio(archivos, estados, todos) {
    const rp = await this.dirSiExiste([DIR_PARTES, this.share]);
    if (!rp) return;
    const conocidos = todos ? new Set(todos.filter((a) => this.geometria(a.tam).ensambla).map((a) => this.nombrePartes(a))) : null;
    if (conocidos) for (const k of [...this.registro.partes.keys()]) if (!conocidos.has(k)) this.registro.partes.delete(k);
    const tocados = new Map();
    for (const a of archivos) if (this.geometria(a.tam).ensambla) tocados.set(this.nombrePartes(a), a);
    for (const [nombre, h] of await listar(rp)) {
      if (nombre === ARCHIVO_REGISTRO) continue;
      const a = tocados.get(nombre);
      if (h.kind !== 'directory') { await borrar(rp, nombre, true); continue; }
      if (!a) {
        // Carpeta de partes que no es de los archivos que se preparan ahora. Se respeta si es de un archivo
        // del manifiesto (no elegido) o, en una revisión parcial, si el registro la conoce; si no, es un resto.
        if (conocidos ? !conocidos.has(nombre) : !this.registro.partes.has(nombre)) await borrar(rp, nombre, true);
        continue;
      }
      const r = estados.get(a.id);
      if (r.completo) { await borrar(rp, nombre, true); this.registro.partes.delete(nombre); continue; }
      for (const [n2] of await listar(h)) {
        const m = /^(0|[1-9][0-9]*)\.parte$/.exec(n2);
        if (!m || !r.hechas.has(Number(m[1]))) await borrar(h, n2, true);
      }
    }
  }

  /* ---------------------------------------------------------------- escribir */

  async abrirUnidad(a, k) {
    const g = this.geometria(a.tam);
    let dir;
    let nombre;
    let fh;
    if (g.ensambla) {
      // Las partes viven en el subdirectorio propio: crear una nunca pisa nada ajeno. Aun así se apunta
      // antes en el registro que la escribe la página.
      let suyas = this.registro.partes.get(this.nombrePartes(a));
      if (!suyas || !suyas.has(k)) {
        if (!suyas) { suyas = new Set(); this.registro.partes.set(this.nombrePartes(a), suyas); }
        suyas.add(k);
        await this.guardarRegistro();
      }
      nombre = `${k}.parte`;
      try {
        fh = await this.enPropio([DIR_PARTES, this.share, this.nombrePartes(a)], async (d) => { dir = d; return d.getFileHandle(nombre, { create: true }); });
      } catch (e) { throw deDisco(e, 'crear la parte'); }
    } else {
      // Nunca se crea ni se pisa un archivo final que no conste antes en el registro como propio.
      if (this.registro.creados.get(this.clave(a)) !== this.nombrePartes(a)) throw new ErrorNombre({ message: 'archivo sin apuntar en el registro' });
      nombre = a.segmentos[a.segmentos.length - 1];
      try { dir = await this.dir(this.rutaFinal(a).slice(0, -1)); } catch (e) { throw alAbrir(e, 'crear carpeta'); }
      try { fh = await dir.getFileHandle(nombre, { create: true }); } catch (e) { throw alAbrir(e, 'crear archivo'); }
    }
    let flujo;
    try { flujo = await fh.createWritable(); } catch (e) { throw deDisco(e, 'abrir para escribir'); }
    return new Unidad(dir, nombre, fh, flujo, g.unidad(k).bytes);
  }

  // Une las partes en el archivo final con un solo flujo, comprueba el tamaño y borra las partes.
  async ensamblar(a, alAvanzar) {
    const g = this.geometria(a.tam);
    if (this.registro.creados.get(this.clave(a)) !== this.nombrePartes(a)) throw new ErrorNombre({ message: 'archivo sin apuntar en el registro' });
    let partes;
    try {
      const dp = await this.dirPartes(a);
      partes = [];
      const malas = [];
      for (let k = 0; k < g.nUnidades; k++) {
        let f = null;
        try { f = await (await dp.getFileHandle(`${k}.parte`)).getFile(); } catch (e) {
          if (!e || e.name !== 'NotFoundError') throw e;
        }
        if (!f || f.size !== g.unidad(k).bytes) malas.push(k);
        else partes.push(f);
      }
      if (malas.length) throw new ErrorPartes(malas);
    } catch (e) { throw deDisco(e, 'leer las partes'); }

    let dir;
    let fh;
    const nombre = a.segmentos[a.segmentos.length - 1];
    try {
      dir = await this.dir(this.rutaFinal(a).slice(0, -1));
      fh = await dir.getFileHandle(nombre, { create: true });
    } catch (e) { throw alAbrir(e, 'crear archivo'); }
    let flujo;
    try { flujo = await fh.createWritable(); } catch (e) { throw deDisco(e, 'abrir para escribir'); }
    try {
      let hecho = 0;
      for (const f of partes) {
        await flujo.write(f); // el navegador copia la parte entera sin pasar por JavaScript
        hecho += f.size;
        if (alAvanzar) alAvanzar(a.tam ? hecho / a.tam : 1);
      }
      await flujo.close();
      const real = (await fh.getFile()).size;
      if (real !== a.tam) throw new ErrorDisco({ name: 'TamanoIncorrecto', message: `${real} en vez de ${a.tam}` }, 'ensamblar');
    } catch (e) {
      try { await flujo.abort(); } catch { /* ya cerrado */ }
      throw deDisco(e, 'ensamblar');
    }
    await this.descartar(a);
  }

  // Borra el trabajo en curso de un archivo (sus partes). No toca el archivo final.
  async descartar(a) {
    const nombre = this.nombrePartes(a);
    this.dirs.delete(`${DIR_PARTES}/${this.share}/${nombre}`);
    this.registro.partes.delete(nombre);
    const rp = await this.dirSiExiste([DIR_PARTES, this.share]).catch(() => null);
    if (rp) await borrar(rp, nombre, true);
  }

  // Quita el subdirectorio de esta compartición (con su registro) y, solo si después queda vacío,
  // también .lata-partes. El borrado de .lata-partes NO es recursivo: si otra compartición tiene algo
  // dentro, falla y se queda.
  async quitarSubdirectorio() {
    await this.escritura.catch(() => {});
    this.olvidarDirsDePartes();
    this.registroEnDisco = false;
    const lp = await this.dirSiExiste([DIR_PARTES]).catch(() => null);
    if (!lp) return;
    await borrar(lp, this.share, true);
    await borrar(this.raiz, DIR_PARTES, false);
  }

  // Cuántas carpetas de partes de ESTA compartición quedan. Si no queda ninguna, ya no hay trabajo en
  // curso: se quita el subdirectorio propio, registro incluido.
  async restos() {
    try {
      await this.escritura.catch(() => {});
      const rp = await this.dirSiExiste([DIR_PARTES, this.share]);
      let n = 0;
      if (rp) for (const [, h] of await listar(rp)) if (h.kind === 'directory') n++;
      if (n === 0) await this.quitarSubdirectorio();
      return n;
    } catch {
      return 0;
    }
  }
}
