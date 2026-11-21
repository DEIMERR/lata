// Planificador de la descarga: reparte trozos entre un grupo acotado de trabajadores (que piden y
// descifran) y entrega cada trozo descifrado a un único escritor, en la página.
//
// Memoria acotada: un trabajador no recibe otro encargo hasta que su trozo anterior está escrito,
// así que nunca hay más datos en claro en vuelo que trabajadores × tamaño de trozo. Los búferes se
// sueltan a mano en cuanto dejan de hacer falta.
//
// Cada archivo del plan (lo crea sesion.js) lleva:
//   id, version, sal, tam, segmentos, geo (geometría del escritor), elegido, bloqueado, error,
//   estado ('cola' | 'ensamblando' | 'hecho'), hechas (Set de unidades cerradas), activas (Set de
//   unidades abiertas), guardados (bytes en unidades cerradas), bytesAbiertos (escritos en unidades
//   aún abiertas), bytesVuelo (recibidos por la red y todavía sin escribir), pctEnsamblado.

import { esperaProgresiva, SIN_DATOS_MS } from './api.js';
import { ErrorDisco, ErrorNombre, ErrorPartes } from './escritor.js';
import { rangoTrozo } from './wire.js';

export const TRABAJADORES_POR_DEFECTO = 4;
// El motor admite 50 peticiones por segundo sostenidas por compartición (contando estado e informes).
// Con archivos o trozos muy pequeños se podría superar: aquí se frena antes de que el motor responda 429.
const PETICIONES_POR_SEGUNDO = 40;

// Vigías. Nada de esto debería saltar nunca; están para que una descarga desatendida no se quede
// parada para siempre por algo que no avisa.
export const PLAZO_LISTO_MS = 30000;        // un trabajador recién creado que no dice «listo» en este tiempo se repone
export const MARGEN_TRABAJO_MS = 30000;     // silencio de un trabajador con un encargo, por encima del vigía de red, antes de darlo por muerto
export const PLAZO_ESCRITURA_MS = 300000;   // abrir, escribir o cerrar en la carpeta: 5 minutos sin terminar es un cuelgue
const BYTES_POR_SEGUNDO_MINIMOS = 4 * 1048576; // al cerrar o unir, el plazo crece con el tamaño (un antivirus puede repasar el archivo entero)

function liberar(buf) {
  try {
    if (buf && typeof buf.transfer === 'function' && !buf.detached) buf.transfer(0);
  } catch { /* no disponible: lo recogerá el recolector */ }
}

export const acotarTrabajadores = (n) => Math.max(1, Math.min(8, Math.floor(Number(n)) || TRABAJADORES_POR_DEFECTO));

export class Descarga {
  // op: { claveBase, credencial, shareIdTexto, shareId, tamTrozo, escritor, trabajadores, sinDatosMs,
  //       urlTrabajador, origen, fijo, alCambiar(), alEvento(tipo, datos),
  //       plazoListoMs, plazoTrabajoMs, plazoEscrituraMs (vigías; solo se cambian en las pruebas) }
  // `origen` es '' en el modo clásico. En el modo fijo (`fijo`) es el origen del motor y puede cambiar
  // con cambiarOrigen(); además se avisa con el evento «seguir» cuando conviene preguntar dónde está.
  constructor(op) {
    this.op = op;
    this.n = acotarTrabajadores(op.trabajadores);
    this.maxActivas = this.n + 2;   // unidades abiertas o cerrándose a la vez (varios archivos pequeños en paralelo)
    this.archivos = [];
    this.cursor = 0;
    this.unidades = [];
    this.trabajadores = [];
    this.trabajos = new Map();
    this.sec = 0;
    this.activa = false;
    this.pausada = false;
    this.puerta = null;             // { motivo, hasta, segundos }: nadie pide nada hasta que se abra
    this.tPuerta = 0;
    this.nivel = 0;                 // escalón de la espera progresiva
    this.generacion = 0;            // cambia en cada cierre de puerta: los fallos viejos no escalan otra vez
    this.sonda = false;             // tras un fallo se prueba con un solo trozo antes de lanzar todos
    this.colaEnsamblado = [];
    this.ensamblando = null;
    this.finAvisado = false;
    this.fallosTrozo = new Map();
    this.fallosTrabajador = 0;
    this.fallosRed = 0;             // intentos seguidos que acabaron sin respuesta del motor (fallo de red, no un estado HTTP)
    this.plazoListo = op.plazoListoMs || PLAZO_LISTO_MS;
    this.plazoTrabajo = op.plazoTrabajoMs || (op.sinDatosMs || SIN_DATOS_MS) + MARGEN_TRABAJO_MS;
    this.plazoEscritura = op.plazoEscrituraMs || PLAZO_ESCRITURA_MS;
    this.salidas = [];              // instantes de las últimas peticiones (para el límite por segundo)
    this.tCupo = 0;
    // Contadores para la interfaz y las pruebas.
    this.bytesRed = 0;              // bytes recibidos por la red (para la velocidad)
    this.trozosRechazados = 0;      // trozos descartados por no autenticarse o no medir lo esperado
  }

  cambio() { if (this.op.alCambiar) this.op.alCambiar(); }
  evento(tipo, datos) { if (this.op.alEvento) this.op.alEvento(tipo, datos); }

  /* ---------------------------------------------------------------- plan */

  establecer(archivos) {
    this.archivos = archivos;
    this.cursor = 0;
    this.finAvisado = false;
    if (this.activa) {
      this.encolarEnsamblados();
      this.bombear();
    }
  }

  // Archivos con todas sus partes ya cerradas a los que solo les falta unirlas.
  encolarEnsamblados() {
    for (const a of this.archivos) {
      if (a.elegido && !a.error && !a.bloqueado && a.estado === 'cola' && a.geo.ensambla && a.hechas.size === a.geo.nUnidades && !this.colaEnsamblado.includes(a)) {
        this.colaEnsamblado.push(a);
      }
    }
    this.procesarEnsamblados();
  }

  iniciar() {
    this.activa = true;
    this.pausada = false;
    this.finAvisado = false;
    this.cursor = 0;
    this.asegurarTrabajadores();
    this.encolarEnsamblados();
    this.bombear();
    this.cambio();
  }

  pausar() {
    this.pausada = true;
    this.quitarPuerta();
    // Se cortan las peticiones en curso; las unidades abiertas se quedan abiertas con lo ya escrito.
    for (const t of [...this.trabajos.values()]) if (t.fase === 'red') this.cancelarTrabajo(t, true);
    this.cambio();
  }

  reanudar() {
    this.pausada = false;
    this.bombear();
    this.cambio();
  }

  // Tras cambiar la selección o el plan: vuelve a mirar desde el principio.
  replanificar() {
    this.cursor = 0;
    this.finAvisado = false;
    if (this.activa) {
      this.encolarEnsamblados();
      this.bombear();
    }
  }

  // Para del todo: corta peticiones, descarta las unidades abiertas y cierra los trabajadores.
  detener() {
    this.activa = false;
    clearTimeout(this.tCupo);
    this.tCupo = 0;
    this.quitarPuerta();
    this.descartarTodo();
    for (const t of this.trabajadores) { clearTimeout(t.tListo); t.w.terminate(); }
    this.trabajadores = [];
  }

  descartarTodo() {
    for (const t of [...this.trabajos.values()]) if (t.fase === 'red') this.cancelarTrabajo(t, false);
    for (const u of [...this.unidades]) this.abortarUnidad(u);
    this.colaEnsamblado = [];
    for (const a of this.archivos) { a.bytesAbiertos = 0; a.bytesVuelo = 0; a.activas.clear(); }
  }

  /* ---------------------------------------------------------------- trabajadores */

  asegurarTrabajadores() {
    while (this.trabajadores.length < this.n) {
      const w = new Worker(this.op.urlTrabajador, { type: 'module', name: 'lata-trabajador' });
      const t = { w, trabajo: null, listo: false, tListo: 0 };
      // Vigía: si el trabajador no llega a decir «listo» (su módulo no termina de cargar), se repone.
      t.tListo = setTimeout(() => { t.tListo = 0; if (!t.listo) this.alFalloTrabajador(t); }, this.plazoListo);
      w.onmessage = (ev) => this.alMensaje(t, ev.data);
      w.onerror = (ev) => { if (ev && ev.preventDefault) ev.preventDefault(); this.alFalloTrabajador(t); };
      w.postMessage({
        tipo: 'inicio', claveBase: this.op.claveBase, credencial: this.op.credencial, shareIdTexto: this.op.shareIdTexto,
        shareId: this.op.shareId, tamTrozo: this.op.tamTrozo, sinDatosMs: this.op.sinDatosMs || SIN_DATOS_MS,
        origen: this.op.origen || '',
      });
      this.trabajadores.push(t);
    }
  }

  alFalloTrabajador(t) {
    const n = this.trabajadores.indexOf(t);
    if (n < 0) return;
    this.trabajadores.splice(n, 1);
    clearTimeout(t.tListo);
    try { t.w.terminate(); } catch { /* ya muerto */ }
    this.fallosTrabajador++;
    const trabajo = [...this.trabajos.values()].find((x) => x.trabajador === t);
    if (trabajo && trabajo.fase === 'red') this.alError(trabajo, { clase: 'red', codigo: 'trabajador' });
    else if (this.activa && !this.puerta) {
      this.nivel++;
      this.cerrarPuerta('red', esperaProgresiva(this.nivel));
    }
  }

  alMensaje(t, m) {
    if (m.tipo === 'listo') {
      t.listo = true;
      clearTimeout(t.tListo);
      t.tListo = 0;
      this.bombear();
      return;
    }
    const trabajo = this.trabajos.get(m.trabajo);
    if (!trabajo || trabajo.trabajador !== t) {
      if (m.tipo === 'hecho') liberar(m.datos); // llegó tarde: el encargo ya se había cancelado
      return;
    }
    if (m.tipo === 'recibido') {
      this.armarVigia(trabajo);     // sigue vivo: llegan datos
      trabajo.recibido += m.bytes;
      trabajo.u.a.bytesVuelo += m.bytes;
      this.bytesRed += m.bytes;
    } else if (m.tipo === 'hecho') {
      this.alHecho(trabajo, m.datos);
    } else if (m.tipo === 'error') {
      this.alError(trabajo, m);
    } else if (m.tipo === 'cancelado') {
      this.cancelarTrabajo(trabajo, true);
      this.bombear();
    }
  }

  // Modo fijo: el motor está ahora en otro origen. Se cortan las peticiones en curso (iban a la
  // dirección vieja) y se vuelven a pedir en la nueva. Las unidades abiertas siguen abiertas con lo
  // ya escrito, y lo cerrado no se toca: no se pierde nada de lo descargado.
  cambiarOrigen(origen) {
    this.op.origen = origen;
    for (const t of this.trabajadores) {
      try { t.w.postMessage({ tipo: 'origen', origen }); } catch { /* trabajador muerto: se repondrá con el origen nuevo */ }
    }
    for (const t of [...this.trabajos.values()]) if (t.fase === 'red') this.cancelarTrabajo(t, true);
    this.generacion++;
    this.nivel = 0;
    this.fallosRed = 0;
    this.sonda = true;              // primero un solo trozo, para comprobar que la dirección nueva responde
    if (this.puerta) this.abrirPuerta();
    else this.bombear();
    this.cambio();
  }

  // Vigía de cada encargo. El trabajador ya corta por su cuenta una petición sin datos y avisa; esto
  // cubre que el propio trabajador muera sin avisar (o se quede colgado): si pasa demasiado tiempo sin
  // ninguna noticia suya, se cierra, se crea otro y el trozo se vuelve a pedir.
  armarVigia(t) {
    clearTimeout(t.vigia);
    t.vigia = setTimeout(() => {
      t.vigia = 0;
      if (this.trabajos.get(t.id) === t && t.fase === 'red') this.alFalloTrabajador(t.trabajador);
    }, this.plazoTrabajo);
  }

  // Vigía de la carpeta: una operación de escritura que no termina en su plazo se da por colgada y
  // sale como un fallo de disco de causa «Plazo» (pasajero: la sesión lo reintenta sola).
  // Devuelve { promesa, latido() }: latido() reinicia la cuenta (para operaciones que van avisando).
  conPlazo(promesa, donde, bytes = 0) {
    const ms = this.plazoEscritura + Math.ceil((bytes / BYTES_POR_SEGUNDO_MINIMOS) * 1000);
    let t = 0;
    let vencer = null;
    const armar = () => {
      clearTimeout(t);
      t = setTimeout(() => vencer(new ErrorDisco({ name: 'Plazo', message: `sin respuesta en ${Math.round(ms / 1000)} s` }, donde)), ms);
    };
    const plazo = new Promise((_, mal) => { vencer = mal; });
    armar();
    const carrera = Promise.race([promesa, plazo]);
    const limpiar = () => clearTimeout(t);
    carrera.then(limpiar, limpiar);
    return { promesa: carrera, latido: armar };
  }

  /* ---------------------------------------------------------------- reparto */

  descargable(a) {
    return a.elegido && !a.bloqueado && !a.error && a.estado === 'cola';
  }

  bombear() {
    if (!this.activa) return;
    if (!this.pausada && !this.puerta) {
      this.asegurarTrabajadores();
      for (const t of this.trabajadores) {
        if (t.trabajo !== null || !t.listo) continue;
        if (this.sonda && this.trabajos.size >= 1) break;
        if (!this.hayCupo()) break;
        const s = this.siguiente();
        if (!s) break;
        this.asignar(t, s.u, s.i);
      }
    }
    this.comprobarFin();
  }

  // Límite propio de peticiones por segundo. Si no hay cupo, se vuelve a repartir en cuanto lo haya.
  hayCupo() {
    const ahora = performance.now();
    while (this.salidas.length && ahora - this.salidas[0] >= 1000) this.salidas.shift();
    if (this.salidas.length < PETICIONES_POR_SEGUNDO) return true;
    if (!this.tCupo) {
      this.tCupo = setTimeout(() => { this.tCupo = 0; this.bombear(); }, Math.max(5, 1005 - (ahora - this.salidas[0])));
    }
    return false;
  }

  siguiente() {
    // Primero se terminan las unidades ya abiertas, por orden de apertura: así se cierran antes.
    for (const u of this.unidades) {
      if (u.estado === 'abierta' && u.pendientes.length && !u.cancelada) return { u, i: u.pendientes.shift() };
    }
    if (this.unidades.length >= this.maxActivas) return null;
    for (let n = this.cursor; n < this.archivos.length; n++) {
      const a = this.archivos[n];
      if (!this.descargable(a)) {
        if (n === this.cursor && (a.estado === 'hecho' || a.error || !a.elegido)) this.cursor++;
        continue;
      }
      for (let k = 0; k < a.geo.nUnidades; k++) {
        if (a.hechas.has(k) || a.activas.has(k)) continue;
        const u = this.crearUnidad(a, k);
        return { u, i: u.pendientes.shift() };
      }
    }
    return null;
  }

  crearUnidad(a, k) {
    const g = a.geo.unidad(k);
    const u = {
      a, k, primer: g.primer, n: g.n, pendientes: [], enVuelo: new Set(), escritos: 0, bytes: 0,
      estado: 'abierta', cancelada: false, flujo: null,
    };
    for (let i = 0; i < g.n; i++) u.pendientes.push(g.primer + i);
    // Se abre ya, en paralelo con la primera petición. Si falla, se sabe antes de malgastar un trozo.
    u.abierto = this.op.escritor.abrirUnidad(a, k);     // tal cual, para poder abortarlo aunque llegue tarde
    u.flujo = this.conPlazo(u.abierto, 'abrir').promesa;
    u.flujo.catch((e) => { if (!u.cancelada) this.falloEscritura(u, e); });
    a.activas.add(k);
    this.unidades.push(u);
    return u;
  }

  asignar(trabajador, u, i) {
    const a = u.a;
    const r = rangoTrozo(a.tam, this.op.tamTrozo, i);
    const t = { id: ++this.sec, u, i, trabajador, generacion: this.generacion, recibido: 0, longitud: r.longitud, fase: 'red', vigia: 0 };
    this.trabajos.set(t.id, t);
    this.armarVigia(t);
    u.enVuelo.add(i);
    trabajador.trabajo = t.id;
    this.salidas.push(performance.now());
    trabajador.w.postMessage({ tipo: 'trozo', trabajo: t.id, fileId: a.id, version: a.version, sal: a.sal, tam: a.tam, indice: i });
  }

  // Quita el encargo y deja libre a su trabajador. No reparte: quien llama decide cuándo.
  retirar(t) {
    if (this.trabajos.get(t.id) !== t) return false;
    clearTimeout(t.vigia);
    t.vigia = 0;
    this.trabajos.delete(t.id);
    if (t.trabajador.trabajo === t.id) t.trabajador.trabajo = null;
    t.u.a.bytesVuelo = Math.max(0, t.u.a.bytesVuelo - t.recibido);
    t.recibido = 0;
    t.u.enVuelo.delete(t.i);
    return true;
  }

  cancelarTrabajo(t, devolver) {
    if (!this.retirar(t)) return;
    try { t.trabajador.w.postMessage({ tipo: 'cancelar', trabajo: t.id }); } catch { /* trabajador muerto */ }
    if (devolver && !t.u.cancelada) t.u.pendientes.unshift(t.i);
  }

  /* ---------------------------------------------------------------- llegada de un trozo */

  async alHecho(t, datos) {
    t.fase = 'escribiendo';
    clearTimeout(t.vigia);
    t.vigia = 0;
    const u = t.u;
    const a = u.a;
    if (t.generacion === this.generacion) { this.nivel = 0; this.sonda = false; }
    this.fallosRed = 0;
    this.fallosTrozo.delete(`${a.id}:${t.i}`);
    if (this.puerta && ['red', 'datos', 'protocolo'].includes(this.puerta.motivo)) this.abrirPuerta();
    let escrito = false;
    try {
      if (!u.cancelada) {
        const flujo = await u.flujo;
        if (!u.cancelada) {
          await this.conPlazo(flujo.escribir((t.i - u.primer) * this.op.tamTrozo, datos), 'escribir').promesa;
          escrito = !u.cancelada;
        }
      }
    } catch (e) {
      if (!u.cancelada) this.falloEscritura(u, e);
    } finally {
      liberar(datos);
    }
    if (escrito) {
      u.escritos++;
      u.bytes += t.longitud;
      a.bytesAbiertos += t.longitud;
    }
    this.retirar(t);
    if (escrito && u.escritos === u.n) this.cerrarUnidad(u);
    this.bombear();
    this.cambio();
  }

  async cerrarUnidad(u) {
    const a = u.a;
    u.estado = 'cerrando';
    try {
      const flujo = await u.flujo;
      await this.conPlazo(flujo.cerrar(), 'cerrar', u.bytes).promesa; // incluye la comprobación del tamaño
    } catch (e) {
      if (!u.cancelada) this.falloEscritura(u, e);
      return;
    }
    if (u.cancelada) return;
    // Solo ahora cuenta: está cerrada y mide exactamente lo esperado.
    const n = this.unidades.indexOf(u);
    if (n >= 0) this.unidades.splice(n, 1);
    a.activas.delete(u.k);
    a.hechas.add(u.k);
    a.bytesAbiertos = Math.max(0, a.bytesAbiertos - u.bytes);
    a.guardados += u.bytes;
    if (a.hechas.size === a.geo.nUnidades) {
      if (a.geo.ensambla) {
        this.colaEnsamblado.push(a);
        this.procesarEnsamblados();
      } else {
        this.completar(a);
      }
    }
    this.evento('unidad', a);
    this.bombear();
    this.cambio();
  }

  completar(a) {
    a.estado = 'hecho';
    a.guardados = a.tam;
    a.bytesAbiertos = 0;
    // Verificado solo si todos sus trozos los bajó y autenticó la página. Si alguna parte se encontró ya
    // hecha en la carpeta sin constar como propia («adoptada»), el archivo queda como «Ya estaba».
    a.verificado = !a.adoptado;
    a.yaEstaba = !!a.adoptado;
    a.cambiado = false;
    this.evento('archivo-hecho', a);
  }

  // Une las partes de los archivos grandes, de uno en uno.
  async procesarEnsamblados() {
    if (this.ensamblando) return;
    for (;;) {
      const a = this.colaEnsamblado.shift();
      if (!a) break;
      if (!this.activa || !a.elegido || a.error || a.estado !== 'cola') continue;
      this.ensamblando = a;
      a.estado = 'ensamblando';
      a.pctEnsamblado = 0;
      this.cambio();
      try {
        // El plazo cuenta desde el último avance, no desde el principio: unir un archivo grande lleva su tiempo.
        let latido = () => {};
        const union = this.conPlazo(this.op.escritor.ensamblar(a, (p) => { latido(); a.pctEnsamblado = p; this.cambio(); }), 'ensamblar', a.tam);
        latido = union.latido;
        await union.promesa;
        if (a.estado === 'ensamblando') this.completar(a);
      } catch (e) {
        if (a.estado === 'ensamblando') a.estado = 'cola';
        if (e instanceof ErrorPartes) {
          // Faltaba alguna parte: se vuelve a bajar solo esa.
          for (const k of e.malas) {
            if (a.hechas.delete(k)) a.guardados = Math.max(0, a.guardados - a.geo.unidad(k).bytes);
          }
          this.cursor = 0;
        } else if (e instanceof ErrorNombre) {
          this.marcarError(a);
        } else {
          this.ensamblando = null;
          this.detenerPorDisco(e);
          return;
        }
      }
      this.ensamblando = null;
      this.bombear();
      this.cambio();
    }
  }

  /* ---------------------------------------------------------------- fallos */

  alError(t, m) {
    const u = t.u;
    const a = u.a;
    const misma = t.generacion === this.generacion;
    if (!this.retirar(t)) return;
    if (!u.cancelada) u.pendientes.unshift(t.i);
    // Modo fijo: un 421 no es el final. El motor ya no atiende en esa dirección (cambió de túnel):
    // se pregunta al punto de encuentro dónde está y, mientras tanto, se sigue intentando.
    const mudanza = m.clase === 'fatal' && m.codigo === 'bad_host' && !!this.op.fijo;
    switch (mudanza ? 'mudanza' : m.clase) {
      case 'fatal':
        this.evento('fatal', { codigo: m.codigo });
        return;
      case 'mudanza':
        if (misma) { this.nivel++; this.cerrarPuerta('red', esperaProgresiva(this.nivel)); }
        this.evento('seguir', { motivo: '421' });
        break;
      case 'version':
      case 'manifiesto':
        // El manifiesto que tenemos ya no vale para este archivo: se aparta hasta tener el nuevo.
        a.bloqueado = true;
        this.abortarArchivo(a);
        this.evento('manifiesto', { archivo: a, motivo: m.clase });
        break;
      case 'espera':
        if (misma) this.cerrarPuerta(m.codigo, m.espera || 5);
        break;
      case 'integridad': {
        // El trozo no se autentica o no mide lo que debe: se descarta entero y se vuelve a pedir.
        const k = `${a.id}:${t.i}`;
        const n = (this.fallosTrozo.get(k) || 0) + 1;
        this.fallosTrozo.set(k, n);
        this.trozosRechazados++;
        this.evento('integridad', { archivo: a, indice: t.i, veces: n });
        if (n >= 3) {
          if (misma) { this.nivel++; this.cerrarPuerta('datos', esperaProgresiva(this.nivel)); }
          if (n === 3) this.evento('refrescar');
        }
        break;
      }
      default:
        if (m.codigo === 'protocolo') console.error('Lata: el emisor respondió HTTP ' + m.estado + ' a la petición de un trozo; no debería ocurrir.');
        if (misma) {
          this.nivel++;
          this.cerrarPuerta(m.codigo === 'protocolo' ? 'protocolo' : 'red', esperaProgresiva(this.nivel));
          // Sin respuesta HTTP (corte, sin datos, cuerpo cortado): al segundo intento seguido que falla así,
          // y en cada uno de los siguientes, se avisa para que el modo fijo pregunte dónde está el motor.
          if (!m.estado) {
            this.fallosRed++;
            if (this.fallosRed >= 2) this.evento('seguir', { motivo: 'red' });
          } else this.fallosRed = 0;
        }
    }
    this.bombear();
    this.cambio();
  }

  cerrarPuerta(motivo, segundos) {
    this.generacion++;
    this.sonda = true;
    clearTimeout(this.tPuerta);
    this.puerta = { motivo, hasta: Date.now() + segundos * 1000, segundos };
    this.tPuerta = setTimeout(() => this.abrirPuerta(), segundos * 1000);
    this.evento('espera', this.puerta);
    this.cambio();
  }

  quitarPuerta() {
    clearTimeout(this.tPuerta);
    this.puerta = null;
  }

  abrirPuerta() {
    if (!this.puerta) return;
    this.quitarPuerta();
    this.evento('espera', null);
    this.bombear();
    this.cambio();
  }

  reintentarAhora() { this.abrirPuerta(); }

  marcarError(a) {
    this.abortarArchivo(a);
    a.error = 'No se puede guardar: este equipo no admite ese nombre';
    this.evento('archivo-error', a);
  }

  falloEscritura(u, e) {
    if (e instanceof ErrorNombre) {
      this.marcarError(u.a);
      this.bombear();
      this.cambio();
      return;
    }
    this.detenerPorDisco(e);
  }

  // Fallo al escribir en la carpeta: se para todo. Al reintentar se reconstruye el estado desde el disco.
  detenerPorDisco(e) {
    if (!this.activa) return;
    this.activa = false;
    this.quitarPuerta();
    this.descartarTodo();
    this.evento('disco', e);
    this.cambio();
  }

  abortarUnidad(u) {
    if (u.cancelada) return;
    u.cancelada = true;
    for (const t of [...this.trabajos.values()]) if (t.u === u && t.fase === 'red') this.cancelarTrabajo(t, false);
    Promise.resolve(u.abierto).then((f) => f.abortar(), () => {});
    const n = this.unidades.indexOf(u);
    if (n >= 0) this.unidades.splice(n, 1);
    u.a.activas.delete(u.k);
    u.a.bytesAbiertos = Math.max(0, u.a.bytesAbiertos - u.bytes);
  }

  // Descarta lo que haya abierto de un archivo (dejó de estar elegido, cambió en el origen, o dio error).
  abortarArchivo(a) {
    for (const u of [...this.unidades]) if (u.a === a) this.abortarUnidad(u);
    const n = this.colaEnsamblado.indexOf(a);
    if (n >= 0) this.colaEnsamblado.splice(n, 1);
    a.bytesAbiertos = 0;
    a.bytesVuelo = 0;
    this.cursor = 0;
  }

  /* ---------------------------------------------------------------- final */

  comprobarFin() {
    if (!this.activa || this.finAvisado) return;
    if (this.trabajos.size || this.unidades.length || this.colaEnsamblado.length || this.ensamblando) return;
    if (this.archivos.some((a) => a.elegido && !a.error && a.estado !== 'hecho')) return;
    this.finAvisado = true;
    this.evento('fin');
  }

  // Identificadores de los archivos en curso (para el informe de avance).
  enCurso() {
    const ids = [];
    for (const u of this.unidades) if (!ids.includes(u.a.id)) ids.push(u.a.id);
    if (this.ensamblando && !ids.includes(this.ensamblando.id)) ids.push(this.ensamblando.id);
    return ids.slice(0, 8);
  }
}
