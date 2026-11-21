// La sesión: une el enlace, las claves, el manifiesto, la carpeta, la selección, la descarga y los
// informes de avance, y decide en qué fase está la página. No toca el DOM: la interfaz lee de aquí.
//
// Fases:
//   cargando      derivando claves y pidiendo el manifiesto (con `espera` si el emisor no responde);
//                 en el modo fijo, antes, preguntando al punto de encuentro dónde está el motor
//   invalido      enlace mal formado, revocado o ilegible          → motivoInvalido
//   incompatible  el navegador no tiene showDirectoryPicker
//   otra-pestana  la misma descarga ya está abierta en otra pestaña de este navegador
//   listo         manifiesto cargado, falta elegir carpeta
//   permiso       hay carpeta recordada pero el navegador pide confirmar el permiso (hace falta un clic)
//   preparando    revisando lo que ya hay en la carpeta (solo lectura hasta saber que no hay choques)
//   colision      en la carpeta hay archivos ajenos con el mismo nombre y otro tamaño: se pregunta → colision
//   descargando   en marcha; `espera` indica si está esperando al emisor y por qué
//   pausado       en pausa por la persona
//   disco         no se pudo escribir en la carpeta                → errorDisco
//   completado    todo lo elegido está en la carpeta               → resumen
//
// Dos modos (docs/PROTOCOLO.md, sección 10.5):
//   clásico   la página la sirve el propio motor en /s/<shareId>; la API está en el mismo origen.
//   fijo      la página vive en un origen fijo. El shareId y el origen del motor salen de un puntero
//             cifrado que se pide a un punto de encuentro; la API va entre orígenes y, si el motor
//             cambia de dirección, la página lo sigue sola sin perder nada (seguirMotor).

import * as almacen from './almacen.js';
import { crearApi, ErrorApi, esperaProgresiva } from './api.js';
import { Descarga, acotarTrabajadores } from './descarga.js';
import { abrirPuntero, derivarClavePuntero, derivarIdPuntero, ErrorPuntero, leerModo, pedirPuntero } from './puntero.js';
import {
  abrirManifiesto, bytesAB64u, derivarClaveAcceso, derivarClaveManifiesto, ErrorManifiesto, importarSecreto,
  sanearRutas,
} from './wire.js';

const INFORME_MIN_MS = 5200;      // como mucho un informe cada 5 s (con margen)
const INFORME_REPOSO_MS = 60000;  // sin cambios, un latido por minuto
const SONDEO_ESTADO_MS = 30000;   // cada cuánto se mira si el manifiesto cambió
const VENTANA_MS = 10000;         // ventana móvil de la velocidad
const PUNTERO_MIN_MS = 900;       // modo fijo: como mucho una consulta al punto de encuentro por segundo

const colator = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });

// El emisor ha enviado un manifiesto con un número de secuencia menor que el mayor ya visto.
class ErrorAntiguo extends Error {}

function nuevoArchivo(f, ruta) {
  return {
    id: f.id, ruta: f.ruta, version: f.version, sal: f.sal, tam: f.tam,
    segmentos: ruta.ok ? ruta.segmentos : null,
    error: ruta.ok ? '' : 'No se puede guardar: ' + ruta.motivo,
    errorCorto: ruta.ok ? '' : 'Nombre no válido',
    geo: null, elegido: true, bloqueado: false,
    estado: 'cola', hechas: new Set(), activas: new Set(),
    guardados: 0, bytesAbiertos: 0, bytesVuelo: 0, pctEnsamblado: 0,
    verificado: false, yaEstaba: false, cambiado: false,
    adoptado: false,    // se monta con alguna parte que la página no escribió: nunca «Verificado»
    recordado: false,   // este navegador recuerda haberlo completado, pero aún no se ha mirado la carpeta
  };
}

export class Sesion {
  // op: { ubicacion: { pathname, hash }, soportado, elegirCarpeta(), crearEscritor(carpeta, tamTrozo, shareIdTexto),
  //       simularPermiso, trabajadores, sinDatosMs, urlTrabajador, alCambiar(), alAviso(texto),
  //       encuentro (el de config.js; '' = solo modo clásico), paginaLocal (la página se sirve desde 127.0.0.1 o localhost) }
  constructor(op) {
    this.op = op;
    this.fase = 'cargando';
    this.motivoInvalido = '';
    this.esperaCarga = null;
    this.enlace = null;
    this.manifiesto = null;
    this.archivos = [];
    this.porId = new Map();
    this.versionPlan = 0;         // sube cuando cambia la lista o la selección (para repintar)
    this.seleccion = { todo: true, ids: new Set() };
    this.carpeta = null;
    this.registro = null;
    this.escritor = null;
    this.descarga = null;
    this.errorDisco = null;
    this.resumen = null;
    this.restos = 0;
    this.velocidad = 0;
    this.muestras = [];
    this.msActivo = 0;
    this.reloj = 0;
    this.ultimoTic = 0;
    this.ultimoSondeo = 0;
    this.ultimoGuardado = 0;
    this.ultimoInforme = 0;
    this.informeEntregado = '';
    this.hechos = new Map();
    this.guardando = false;
    this.guardarOtraVez = false;
    this.informando = false;
    this.tInforme = 0;
    this.refresco = null;
    this.sinCambio = 0;
    this.despertadores = new Set();
    this.simularPermiso = !!op.simularPermiso;
    this.terminando = false;
    this.vigilando = false;
    this.informeRechazado = false;
    this.esperasVistas = new Set();   // motivos de espera que ha habido (para las pruebas)
    this.seqMax = 0;                  // mayor manifestSeq visto para esta compartición
    this.esperaManifiesto = null;     // el emisor envió un manifiesto más antiguo: se reintenta
    this.colision = null;             // { archivos: [{ id, ruta, aqui, llega }], subcarpeta }
    this.completadaAntes = false;     // este navegador recuerda haber terminado ya esta descarga
    this.pideCarpeta = false;         // hay que volver a elegir la carpeta para añadir archivos
    this.nombreCarpetaFinal = '';
    this.trozosRechazados = 0;
    // Modo fijo (sección 10). `fijo` es null en el modo clásico.
    //   { encuentro, id (16 bytes), idTexto, clave, seq (mayor visto), pidiendo, ultima, consultas }
    this.fijo = null;
    this.origen = '';                 // origen del motor; '' = el de la propia página (modo clásico)
    this.cambiosOrigen = 0;           // veces que se ha seguido al motor a otra dirección
    this.fallosRedManifiesto = 0;     // peticiones seguidas del manifiesto que acabaron sin respuesta del motor
  }

  cambio() { if (this.op.alCambiar) this.op.alCambiar(); }
  aviso(texto) { if (this.op.alAviso) this.op.alAviso(texto); }

  ponerFase(fase) {
    if (this.fase === fase) return;
    this.fase = fase;
    if (fase !== 'descargando') { this.muestras = []; this.velocidad = 0; }
    this.programarInforme();
    this.cambio();
  }

  // Espera que se puede acortar con «Reintentar ahora».
  dormir(ms) {
    return new Promise((ok) => {
      const fin = () => { clearTimeout(t); this.despertadores.delete(fin); ok(); };
      const t = setTimeout(fin, ms);
      this.despertadores.add(fin);
    });
  }

  reintentarAhora() {
    for (const d of [...this.despertadores]) d();
    if (this.descarga) this.descarga.reintentarAhora();
  }

  // Lo que la interfaz enseña como «esperando al emisor»: { motivo, hasta } o null.
  get espera() {
    if (this.esperaCarga) return this.esperaCarga;
    if (this.esperaManifiesto && ['descargando', 'preparando'].includes(this.fase)) return this.esperaManifiesto;
    if (this.fase === 'descargando' && this.descarga && this.descarga.puerta) return this.descarga.puerta;
    return null;
  }

  /* ---------------------------------------------------------------- arranque */

  async arrancar() {
    const u = this.op.ubicacion;
    const modo = leerModo(u.pathname, u.hash, this.op.encuentro, !!this.op.paginaLocal);
    if (!modo) return this.invalidar('formato');
    if (!this.op.soportado) return this.ponerFase('incompatible');

    if (modo.modo === 'fijo') {
      // El shareId y la dirección del motor no van en el enlace: salen del puntero.
      try {
        this.claveBase = await importarSecreto(modo.secreto);
        const id = await derivarIdPuntero(this.claveBase);
        this.fijo = {
          encuentro: modo.encuentro, id, idTexto: bytesAB64u(id), clave: await derivarClavePuntero(this.claveBase),
          seq: 0, pidiendo: null, repetir: false, ultima: 0, consultas: 0,
        };
      } catch {
        return this.invalidar('formato');
      }
      if (!(await this.esperarMotor())) return;
    } else if (!(await this.identificar(modo))) return;

    if (!(await this.cargarManifiesto())) return;
    this.iniciarReloj();
    this.programarInforme();

    if (this.registro.carpeta) {
      this.carpeta = this.registro.carpeta;
      if ((await this.consultarPermiso()) === 'granted') return this.comenzar();
      // Sin permiso no se puede mirar la carpeta. Mientras tanto se enseña, sin darlo por bueno, lo que
      // este navegador recuerda haber completado, para no asustar con un 0 %.
      // Es solo un recuerdo: no cuenta como guardado ni como verificado hasta leer la carpeta.
      for (const a of this.archivos) a.recordado = !a.error && this.hechos.get(a.id) === a.version;
      this.versionPlan++;
      return this.ponerFase('permiso');
    }
    this.ponerFase('listo');
  }

  // Ya se sabe qué compartición es: una sola pestaña, claves, cliente de la API y lo que este navegador
  // recuerda de ella. Devuelve false si la página se queda en otra fase (otra pestaña, enlace no válido).
  async identificar(enlace) {
    // El secreto en claro no se guarda en la sesión: basta con la clave base (no extraíble) que sale de él.
    this.enlace = { shareIdTexto: enlace.shareIdTexto, shareId: enlace.shareId };

    // Dos pestañas escribiendo en la misma carpeta se pisarían: solo una lleva la descarga.
    if (navigator.locks) {
      const libre = await new Promise((res) => {
        navigator.locks.request('lata-' + enlace.shareIdTexto, { ifAvailable: true }, (candado) => {
          res(!!candado);
          return candado ? new Promise(() => {}) : undefined; // se retiene mientras viva la pestaña
        }).catch(() => res(true));
      });
      if (!libre) { this.ponerFase('otra-pestana'); return false; }
    }

    try {
      if (!this.claveBase) this.claveBase = await importarSecreto(enlace.secreto);
      this.credencial = bytesAB64u(await derivarClaveAcceso(this.claveBase, enlace.shareId));
      this.claveManifiesto = await derivarClaveManifiesto(this.claveBase, enlace.shareId);
    } catch {
      this.invalidar('formato');
      return false;
    }
    this.api = crearApi({ shareIdTexto: enlace.shareIdTexto, credencial: this.credencial, sinDatosMs: this.op.sinDatosMs, origen: this.origen });

    const guardado = await almacen.leer(enlace.shareIdTexto);
    this.registro = guardado || { shareId: enlace.shareIdTexto, clientId: '', carpeta: null, seleccion: null, msActivo: 0 };
    if (!/^[A-Za-z0-9_-]{22}$/.test(this.registro.clientId || '')) {
      this.registro.clientId = bytesAB64u(crypto.getRandomValues(new Uint8Array(16)));
      this.guardarRegistro();
    }
    this.hechos = await almacen.leerHechos(enlace.shareIdTexto);
    this.msActivo = Number(this.registro.msActivo) || 0;
    this.seqMax = Number.isSafeInteger(this.registro.seq) && this.registro.seq > 0 ? this.registro.seq : 0;
    // Modo fijo: mayor `seq` de puntero visto. Es solo una pista contra un puntero viejo.
    if (this.fijo) this.fijo.seq = Number.isSafeInteger(this.registro.seqPuntero) && this.registro.seqPuntero > 0 ? this.registro.seqPuntero : 0;
    this.completadaAntes = !!this.registro.completada;
    const s = this.registro.seleccion;
    if (s && s.todo === false && Array.isArray(s.ids)) this.seleccion = { todo: false, ids: new Set(s.ids) };
    return true;
  }

  /* ---------------------------------------------------------------- modo fijo: puntero y seguir al motor */

  // Una consulta al punto de encuentro: { puntero } si hay uno que se abre con este enlace y cumple el
  // contrato, o { motivo, espera } si no (motivos: 'sin-puntero', 'encuentro', 'puntero-no-vale').
  async pedirPuntero() {
    const f = this.fijo;
    f.consultas++;
    f.ultima = Date.now();
    try {
      const cuerpo = await pedirPuntero(f.encuentro, f.idTexto);
      return { puntero: await abrirPuntero(f.clave, f.id, cuerpo, { paginaLocal: !!this.op.paginaLocal }) };
    } catch (e) {
      if (e instanceof ErrorPuntero && e.codigo === 'no_existe') return { motivo: 'sin-puntero', espera: 0 };
      if (e instanceof ErrorPuntero && e.codigo === 'no_valido') {
        console.warn('Lata: el punto de encuentro devolvió un puntero que no vale (' + e.message + ').');
        return { motivo: 'puntero-no-vale', espera: 0 };
      }
      return { motivo: 'encuentro', espera: (e instanceof ErrorPuntero && e.espera) || 0 };
    }
  }

  // Decide qué hacer con un puntero ya abierto y validado. Devuelve:
  //   'ajeno'     habla de otra compartición: no se usa
  //   'antiguo'   su seq es menor que el mayor ya visto: no se usa
  //   'revocado'  quien comparte dejó de compartir: la página se detiene, como ante un 401
  //   'cambio'    se ha fijado (o cambiado) el origen del motor
  //   'igual'     nada nuevo
  aplicarPuntero(p) {
    const f = this.fijo;
    if (p.shareIdTexto !== this.enlace.shareIdTexto) return 'ajeno';
    if (p.seq < f.seq) {
      this.punterosAntiguos = (this.punterosAntiguos || 0) + 1;
      return 'antiguo';
    }
    const nuevo = p.seq > f.seq;
    if (nuevo) {
      f.seq = p.seq;
      this.registro.seqPuntero = p.seq;
      this.guardarRegistro();
    }
    if (p.estado === 'revocado') {
      this.invalidar('revocado');
      return 'revocado';
    }
    // Al abrir se acepta el puntero aunque su seq sea igual al ya visto. Después, solo uno con seq
    // mayor puede mover la descarga a otro origen.
    if (!this.origen || (nuevo && p.origen !== this.origen)) {
      this.ponerOrigen(p.origen);
      return 'cambio';
    }
    return 'igual';
  }

  // Fija el origen del motor. Si ya había otro, la descarga se muda en caliente: la API y los
  // trabajadores pasan a pedir en la dirección nueva y todo lo que esperaba una cuenta atrás se
  // reintenta ya. El estado y lo ya escrito en la carpeta no se tocan.
  ponerOrigen(origen) {
    const mudanza = !!this.origen;
    this.origen = origen;
    if (this.api) this.api.cambiarOrigen(origen);
    if (!mudanza) return;
    this.cambiosOrigen++;
    this.fallosRedManifiesto = 0;
    if (this.descarga) this.descarga.cambiarOrigen(origen);
    this.reintentarAhora();
    // El motor puede haber vuelto con otra lista de archivos: se mira cuanto antes.
    if (this.manifiesto && this.descarga && !this.refresco && this.fase === 'descargando') {
      this.ultimoSondeo = Date.now();
      this.sondear();
    }
    this.cambio();
  }

  // Modo fijo, al abrir: pregunta al punto de encuentro hasta tener un puntero vigente que diga dónde
  // está el motor. Que no haya puntero o que el punto de encuentro no responda no es un error: se espera
  // a quien comparte y se reintenta, sin límite. Devuelve false si la página se queda en otra fase.
  async esperarMotor() {
    for (let intento = 0; ;) {
      const r = await this.pedirPuntero();
      let motivo = r.motivo;
      if (r.puntero) {
        const p = r.puntero;
        if (!this.enlace && !(await this.identificar({ shareIdTexto: p.shareIdTexto, shareId: p.shareId }))) return false;
        const que = this.aplicarPuntero(p);
        if (que === 'revocado') return false;
        if (this.origen) {
          this.esperaCarga = null;
          return true;
        }
        motivo = que === 'antiguo' ? 'puntero-antiguo' : 'puntero-no-vale';
      }
      const segundos = Math.max(r.espera || 0, esperaProgresiva(++intento));
      this.esperaCarga = { motivo, hasta: Date.now() + segundos * 1000, segundos };
      this.esperasVistas.add(motivo);
      this.cambio();
      await this.dormir(segundos * 1000);
      if (this.fase === 'invalido') return false;
    }
  }

  // Modo fijo, con la página ya en marcha: vuelve a preguntar dónde está el motor. Se llama tras dos
  // fallos de red seguidos contra el motor (y en cada reintento fallido posterior), ante un 421 y al
  // volver la conexión. Si el puntero trae un seq mayor con otro origen, la descarga se muda sola; si
  // no hay nada nuevo (o el punto de encuentro no responde), se sigue intentando contra el origen conocido.
  // `ya`: sin el límite de una consulta por segundo y, si hay una en curso (que pudo salir sin red),
  // con otra justo después. Es lo que se usa al volver la conexión.
  seguirMotor(ya = false) {
    const f = this.fijo;
    if (!f || !this.origen || this.fase === 'invalido') return null;
    if (f.pidiendo) {
      if (ya) f.repetir = true;
      return f.pidiendo;
    }
    if (!ya && Date.now() - f.ultima < PUNTERO_MIN_MS) return null;
    f.pidiendo = (async () => {
      try {
        do {
          f.repetir = false;
          const r = await this.pedirPuntero();
          if (r.puntero && this.fase !== 'invalido') this.aplicarPuntero(r.puntero);
        } while (f.repetir && this.fase !== 'invalido');
      } finally {
        f.pidiendo = null;
      }
    })();
    return f.pidiendo;
  }

  // ¿Es un 421 en el modo fijo? Entonces no es el final: el motor ya no atiende en esa dirección.
  esMudanza(e) {
    return !!this.fijo && e instanceof ErrorApi && e.codigo === 'bad_host';
  }

  // Respuesta «fatal» del motor fuera de la descarga de trozos (estado, informes). Devuelve true si la
  // página se ha detenido; en el modo fijo, ante un 421, pregunta dónde está el motor y sigue.
  alFatal(e) {
    if (this.esMudanza(e)) {
      this.seguirMotor();
      return false;
    }
    this.invalidar('revocado');
    return true;
  }

  // Ha vuelto la conexión de este equipo: no se espera a que venza la cuenta atrás y, en el modo fijo,
  // se pregunta de nuevo dónde está el motor (pudo cambiar de dirección mientras tanto).
  alConectar() {
    this.reintentarAhora();
    this.seguirMotor(true);
  }

  invalidar(motivo) {
    this.motivoInvalido = motivo;
    this.esperaCarga = null;
    this.esperaManifiesto = null;
    this.colision = null;
    if (this.descarga) this.descarga.detener();
    this.soltarCarpeta();
    clearInterval(this.reloj);
    clearTimeout(this.tInforme);
    this.fase = 'invalido';
    this.cambio();
    return false;
  }

  // Deja de tener acceso a la carpeta: fuera de IndexedDB y de la memoria. Se hace al completar la
  // descarga y ante un enlace no válido o revocado (401).
  soltarCarpeta() {
    if (this.carpeta) this.nombreCarpetaFinal = this.carpeta.name || '';
    this.carpeta = null;
    this.escritor = null;
    this.descarga = null;
    if (this.registro && this.registro.carpeta) {
      this.registro.carpeta = null;
      this.guardarRegistro();
    }
  }

  // Pide y abre el manifiesto. Reintenta sin límite mientras el fallo sea de red o de espera.
  async cargarManifiesto() {
    let mudanzas = this.cambiosOrigen;
    for (let intento = 0; ;) {
      try {
        const { cuerpo } = await this.api.manifiesto();
        this.fallosRedManifiesto = 0;
        const m = await abrirManifiesto(this.claveManifiesto, cuerpo, this.enlace.shareId);
        // Protección contra un manifiesto antiguo: nunca se aplica uno con un número menor que el mayor visto.
        if (m.seq < this.seqMax) throw new ErrorAntiguo();
        this.esperaCarga = null;
        this.esperaManifiesto = null;
        this.anotarSeq(m.seq);
        await this.aplicarManifiesto(m);
        return true;
      } catch (e) {
        if (e instanceof ErrorManifiesto) return this.invalidar('manifiesto');
        const mudanza = this.esMudanza(e);
        if (e instanceof ErrorApi && e.clase === 'fatal' && !mudanza) return this.invalidar(e.codigo === 'bad_host' ? 'host' : 'revocado');
        // Tras seguir al motor a otra dirección, la espera progresiva empieza de nuevo.
        if (mudanzas !== this.cambiosOrigen) { mudanzas = this.cambiosOrigen; intento = 0; }
        if (this.fijo) {
          // Modo fijo: al segundo fallo de red seguido (sin respuesta HTTP), y en cada uno de los
          // siguientes, o ante un 421, se pregunta al punto de encuentro dónde está el motor.
          const sinRespuesta = e instanceof ErrorApi && e.clase === 'red' && !e.estado;
          this.fallosRedManifiesto = sinRespuesta ? this.fallosRedManifiesto + 1 : 0;
          if (mudanza || this.fallosRedManifiesto >= 2) this.seguirMotor();
        }
        let segundos;
        let motivo = e instanceof ErrorApi && e.codigo === 'protocolo' ? 'protocolo' : 'red';
        if (motivo === 'protocolo') console.error('Lata: el emisor respondió HTTP ' + e.estado + ' al pedir el manifiesto; no debería ocurrir.');
        if (e instanceof ErrorAntiguo) motivo = 'antiguo';
        if (e instanceof ErrorApi && e.clase === 'espera') { segundos = e.espera; motivo = e.codigo; } else segundos = esperaProgresiva(++intento);
        if (!this.manifiesto) {
          this.esperaCarga = { motivo, hasta: Date.now() + segundos * 1000, segundos };
          this.cambio();
        } else if (motivo === 'antiguo') {
          this.esperaManifiesto = { motivo, hasta: Date.now() + segundos * 1000, segundos };
          this.esperasVistas.add('antiguo');
          this.cambio();
        }
        await this.dormir(segundos * 1000);
        if (this.fase === 'invalido') return false;
      }
    }
  }

  // Apunta el mayor manifestSeq visto, en IndexedDB y (si ya hay registro) en la carpeta.
  anotarSeq(seq) {
    if (seq > this.seqMax) {
      this.seqMax = seq;
      this.registro.seq = seq;
      this.guardarRegistro();
    }
    if (this.escritor) this.escritor.anotarSeq(seq);
  }

  // Sustituye el plan por el del manifiesto nuevo, conservando el estado de los archivos que no cambian.
  async aplicarManifiesto(m) {
    const antes = this.porId;
    const mismo = !!this.manifiesto && this.manifiesto.seq === m.seq;
    const cambioTrozo = !!this.manifiesto && this.manifiesto.tamTrozo !== m.tamTrozo;
    const rutas = sanearRutas(m.archivos);
    const lista = [];
    const sustituidos = [];
    const conservados = new Set();
    for (const f of m.archivos) {
      const v = antes.get(f.id);
      const r = rutas.get(f.id);
      if (v && !cambioTrozo && v.version === f.version && v.tam === f.tam && v.ruta === f.ruta) {
        if (!mismo) v.bloqueado = false; // si el manifiesto no ha cambiado, se desbloquea tras una espera
        v.sal = f.sal;
        conservados.add(v);
        lista.push(v);
        continue;
      }
      const a = nuevoArchivo(f, r);
      if (v) {
        a.cambiado = true;
        sustituidos.push(v);
        this.aviso(`«${a.ruta}» cambió en el origen. Se descarga de nuevo.`);
      }
      lista.push(a);
    }
    for (const v of antes.values()) if (!conservados.has(v) && !sustituidos.includes(v)) sustituidos.push(v);
    for (const v of sustituidos) {
      if (this.descarga) this.descarga.abortarArchivo(v);
      if (this.escritor && v.segmentos && !cambioTrozo) await this.escritor.descartar(v).catch(() => {});
    }
    lista.sort((x, y) => colator.compare(x.ruta, y.ruta));
    for (const a of lista) {
      a.elegido = this.seleccion.todo || this.seleccion.ids.has(a.id);
      if (this.escritor && !a.geo && !cambioTrozo) a.geo = this.escritor.geometria(a.tam);
    }
    this.archivos = lista;
    this.porId = new Map(lista.map((a) => [a.id, a]));
    this.manifiesto = m;
    this.versionPlan++;
    const nuevos = lista.filter((a) => !conservados.has(a) && a.segmentos);
    const enMarcha = !!this.descarga && !!this.escritor && (this.fase === 'descargando' || this.fase === 'pausado');
    if (enMarcha && !cambioTrozo && nuevos.length) {
      // Hasta revisarlos en la carpeta no se pueden descargar (podrían chocar con archivos ajenos).
      for (const a of nuevos) a.bloqueado = true;
      this.descarga.establecer(this.archivos);
      if (!(await this.admitir(nuevos))) return;
    }
    if (cambioTrozo && this.escritor) {
      // Cambió el tamaño de trozo: nada de lo que hay a medias encaja. Se empieza la revisión de cero.
      if (this.descarga) { this.descarga.detener(); this.descarga = null; }
      this.escritor = null;
      for (const a of lista) a.geo = null;
      if (['descargando', 'pausado', 'completado'].includes(this.fase)) await this.comenzar();
    } else if (this.descarga) {
      this.descarga.establecer(this.archivos);
    }
    this.cambio();
  }

  // Vuelve a pedir el manifiesto tras un 404, un 409 o un cambio de secuencia. Una sola vez a la vez.
  refrescarManifiesto() {
    if (!this.refresco) {
      this.refresco = (async () => {
        try {
          const antes = this.manifiesto.seq;
          // Tras un 409 el manifiesto del motor puede tardar un instante en ponerse al día: se espera
          // alrededor de un segundo antes de pedirlo, y lo mismo entre una petición y la siguiente.
          await this.dormir(1000);
          if (this.fase === 'invalido') return;
          if (!(await this.cargarManifiesto())) return;
          if (this.manifiesto.seq === antes) {
            // El emisor dice que algo cambió pero el manifiesto es el mismo: se insiste, cada vez más despacio.
            this.sinCambio++;
            await this.dormir(esperaProgresiva(this.sinCambio) * 1000);
            for (const a of this.archivos) a.bloqueado = false;
          } else {
            this.sinCambio = 0;
          }
        } finally {
          this.refresco = null;
          if (this.descarga) this.descarga.replanificar();
          this.cambio();
        }
      })();
    }
    return this.refresco;
  }

  /* ---------------------------------------------------------------- carpeta y permiso */

  async consultarPermiso() {
    if (this.simularPermiso) return 'prompt';
    try {
      return await this.carpeta.queryPermission({ mode: 'readwrite' });
    } catch {
      return 'prompt';
    }
  }

  // Tiene que llamarse desde un clic: el navegador solo enseña su ventana tras un gesto.
  async elegirCarpeta() {
    let carpeta;
    try {
      carpeta = await this.op.elegirCarpeta();
    } catch (e) {
      if (e && e.name === 'AbortError') return false; // cerró la ventana sin elegir
      this.aviso('No se pudo usar esa carpeta. El navegador no deja usar carpetas del sistema: crea una carpeta nueva y elígela.');
      return false;
    }
    if (!carpeta) return false;
    // Si es otra carpeta, lo que se sabía de la anterior ya no vale.
    let misma = false;
    try { misma = !!this.carpeta && (await this.carpeta.isSameEntry(carpeta)); } catch { /* se trata como distinta */ }
    if (this.descarga) { this.descarga.detener(); this.descarga = null; }
    this.escritor = null;
    for (const a of this.archivos) {
      a.geo = null;
      if (!misma) { a.verificado = false; a.yaEstaba = false; }
    }
    if (!misma) {
      this.hechos = new Map();
      almacen.olvidarHechos(this.enlace.shareIdTexto);
    }
    this.carpeta = carpeta;
    this.simularPermiso = false;
    this.completadaAntes = false;
    this.registro.carpeta = carpeta;
    this.registro.completada = 0;
    this.guardarRegistro();
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch { /* opcional */ }
    await this.comenzar();
    return true;
  }

  // También desde un clic.
  async concederPermiso() {
    let p = 'denied';
    if (this.simularPermiso) { this.simularPermiso = false; p = 'granted'; } else {
      try { p = await this.carpeta.requestPermission({ mode: 'readwrite' }); } catch { p = 'denied'; }
    }
    if (p !== 'granted') {
      this.aviso('Sin ese permiso no se puede seguir guardando en la carpeta. Vuelve a pulsar y acepta, o elige otra carpeta.');
      return false;
    }
    await this.comenzar();
    return true;
  }

  get nombreCarpeta() { return (this.carpeta && this.carpeta.name) || this.nombreCarpetaFinal || ''; }
  // Subcarpeta donde se guarda todo, si se eligió una al chocar con archivos que ya había.
  get destino() { return this.escritor ? this.escritor.registro.destino : this.destinoFinal || ''; }

  /* ---------------------------------------------------------------- descarga */

  // Revisa la carpeta y arranca (o continúa). Se llama al elegir carpeta, al volver, tras un fallo de
  // disco y tras responder a la pregunta de los archivos que chocan.
  async comenzar() {
    this.errorDisco = null;
    this.resumen = null;
    this.colision = null;
    this.pideCarpeta = false;
    if (this.descarga) { this.descarga.detener(); this.descarga = null; }
    this.ponerFase('preparando');
    let estados;
    const validos = () => this.archivos.filter((a) => a.segmentos);
    try {
      if (!this.escritor) {
        this.escritor = this.op.crearEscritor(this.carpeta, this.manifiesto.tamTrozo, this.enlace.shareIdTexto);
        await this.escritor.cargarRegistro();
        // Sin registro en la carpeta (descarga ya terminada, o carpeta nueva): si este navegador recuerda
        // que esta compartición se guardó en una subcarpeta y sigue ahí, se usa esa en vez de volver a preguntar.
        const d = this.registro.destino;
        if (!this.escritor.registroEnDisco && typeof d === 'string' && d !== '' && (await this.escritor.existeCarpeta(d))) this.escritor.fijarDestino(d);
      }
      // El registro de la carpeta también recuerda el mayor manifestSeq (sobrevive a un cambio de origen).
      const enDisco = this.escritor.registro.seq;
      if (enDisco > this.seqMax) {
        this.seqMax = enDisco;
        this.registro.seq = enDisco;
        this.guardarRegistro();
      }
      if (this.manifiesto.seq < this.seqMax) {
        this.esperaManifiesto = { motivo: 'antiguo', hasta: Date.now() + 1000, segundos: 1 };
        this.esperasVistas.add('antiguo');
        this.cambio();
        if (!(await this.cargarManifiesto())) return;   // insiste hasta recibir uno que no sea más antiguo
        if (this.fase !== 'preparando') return;
      }
      this.escritor.anotarSeq(this.manifiesto.seq);
      for (const a of this.archivos) if (!a.geo) a.geo = this.escritor.geometria(a.tam);

      // 1) Solo lectura: qué hay en la carpeta.
      estados = await this.escritor.revisar(validos());
      // 2) Archivos ajenos con el mismo nombre y otro tamaño: se pregunta antes de tocar nada.
      const chocan = validos().filter((a) => a.elegido && estados.get(a.id).estado === 'colision');
      if (chocan.length) {
        this.colision = {
          archivos: chocan.map((a) => ({ id: a.id, ruta: a.ruta, aqui: estados.get(a.id).tamDisco, llega: a.tam })),
          subcarpeta: await this.escritor.proponerSubcarpeta(this.manifiesto.nombre),
        };
        this.ponerFase('colision');
        return;
      }
      // 3) Se apunta lo que la página va a crear y, solo entonces, se limpian sus restos.
      await this.escritor.preparar(validos().filter((a) => a.elegido), estados, { todos: validos() });
    } catch (e) {
      this.falloDisco(e);
      return;
    }
    this.aplicarEstados(validos(), estados);
    this.descarga = new Descarga({
      claveBase: this.claveBase, credencial: this.credencial, shareIdTexto: this.enlace.shareIdTexto, shareId: this.enlace.shareId,
      tamTrozo: this.manifiesto.tamTrozo, escritor: this.escritor, trabajadores: acotarTrabajadores(this.op.trabajadores),
      sinDatosMs: this.op.sinDatosMs, urlTrabajador: this.op.urlTrabajador, origen: this.origen, fijo: !!this.fijo,
      alCambiar: () => this.cambio(), alEvento: (tipo, datos) => this.alEvento(tipo, datos),
    });
    this.descarga.establecer(this.archivos);
    this.versionPlan++;
    this.ultimoSondeo = Date.now();
    this.fase = 'descargando';
    this.programarInforme();
    this.descarga.iniciar(); // si no queda nada, avisa «fin» enseguida
    this.cambio();
  }

  // Respuesta a la pregunta de los archivos que chocan. Hasta aquí no se ha tocado nada de la carpeta.
  //   'subcarpeta'  todo se guarda en una subcarpeta nueva; lo que había se queda como está
  //   'reemplazar'  se permite sustituir exactamente los archivos listados
  async resolverColision(como) {
    if (this.fase !== 'colision' || !this.colision || !this.escritor) return;
    const c = this.colision;
    if (como === 'subcarpeta') {
      this.escritor.fijarDestino(c.subcarpeta);
      this.registro.destino = c.subcarpeta;
      this.guardarRegistro();
    } else if (como === 'reemplazar') {
      this.registro.destino = this.escritor.registro.destino;
      this.guardarRegistro();
      this.escritor.permitirReemplazo(c.archivos.map((x) => this.porId.get(x.id)).filter(Boolean).map((a) => this.escritor.clave(a)));
    } else return;
    await this.comenzar();
  }

  // Pasa al plan lo que se ha visto en la carpeta. El estado sale siempre del disco, nunca de IndexedDB.
  aplicarEstados(archivos, estados) {
    for (const a of archivos) {
      const r = estados.get(a.id);
      if (!r) continue;
      a.recordado = false;
      a.activas.clear();
      a.bytesAbiertos = 0;
      a.bytesVuelo = 0;
      a.pctEnsamblado = 0;
      a.error = '';
      a.errorCorto = '';
      a.adoptado = r.adoptado;
      if (r.estado === 'ocupado') {
        a.error = 'No se puede guardar: en la carpeta ya hay una carpeta con ese nombre';
        a.errorCorto = 'Nombre ocupado';
        a.estado = 'cola';
        a.hechas = new Set();
        a.guardados = 0;
      } else if (r.completo) {
        a.estado = 'hecho';
        a.guardados = a.tam;
        a.hechas = new Set();
        a.verificado = r.verificado;   // solo lo que la página creó ella misma y mide lo esperado
        a.yaEstaba = !r.verificado;
      } else {
        a.estado = 'cola';
        a.verificado = false;
        a.yaEstaba = false;
        a.hechas = r.hechas;
        a.guardados = 0;
        for (const k of r.hechas) a.guardados += a.geo.unidad(k).bytes;
      }
    }
  }

  // Archivos que entran con la descarga ya en marcha (manifiesto nuevo o selección ampliada): se revisan
  // en la carpeta y se apuntan antes de poder descargarse. Si alguno choca con un archivo ajeno, se para
  // todo y se pregunta. Devuelve false si la descarga se ha detenido.
  async admitir(nuevos) {
    try {
      for (const a of nuevos) if (!a.geo) a.geo = this.escritor.geometria(a.tam);
      const estados = await this.escritor.revisar(nuevos);
      if (nuevos.some((a) => a.elegido && estados.get(a.id).estado === 'colision')) {
        await this.comenzar();
        return false;
      }
      await this.escritor.preparar(nuevos.filter((a) => a.elegido), estados);
      this.aplicarEstados(nuevos, estados);
      for (const a of nuevos) a.bloqueado = false;
      return true;
    } catch (e) {
      this.falloDisco(e);
      return false;
    }
  }

  alEvento(tipo, datos) {
    switch (tipo) {
      case 'integridad':
        this.trozosRechazados++;
        break;
      case 'archivo-hecho':
        this.hechos.set(datos.id, datos.version);
        almacen.marcarHecho(this.enlace.shareIdTexto, datos.id, datos.version);
        break;
      case 'archivo-error':
        datos.errorCorto = 'No se pudo guardar';
        this.aviso(`«${datos.ruta}» no se puede guardar en este equipo.`);
        break;
      case 'manifiesto':
      case 'refrescar':
        this.refrescarManifiesto();
        break;
      case 'fatal':
        this.invalidar(datos.codigo === 'bad_host' ? 'host' : 'revocado');
        break;
      case 'seguir':
        this.seguirMotor();
        break;
      case 'disco':
        this.falloDisco(datos);
        break;
      case 'espera':
        if (datos) this.esperasVistas.add(datos.motivo);
        this.programarInforme();
        if (datos && (datos.motivo === 'paused' || datos.motivo === 'source_unavailable')) this.vigilarEmisor();
        break;
      case 'fin':
        this.terminar();
        break;
      default:
    }
    this.cambio();
  }

  // Mientras el emisor está en pausa o sin disco, el manifiesto y los trozos dan 503 pero «status»
  // responde: se le pregunta cada 2 s para enseñar el motivo correcto y reanudar en cuanto vuelva.
  async vigilarEmisor() {
    if (this.vigilando) return;
    this.vigilando = true;
    try {
      for (;;) {
        await this.dormir(2000);
        const p = this.descarga && this.descarga.puerta;
        if (this.fase !== 'descargando' || !p || (p.motivo !== 'paused' && p.motivo !== 'source_unavailable')) return;
        try {
          const st = await this.api.estado(AbortSignal.timeout(8000));
          if (this.descarga.puerta !== p) continue;
          if (st.state === 'active') { this.descarga.reintentarAhora(); return; }
          if (st.state !== p.motivo) { p.motivo = st.state; this.cambio(); }
        } catch (e) {
          if (e instanceof ErrorApi && e.clase === 'fatal' && this.alFatal(e)) return;
          // Sin respuesta: se sigue esperando; la propia descarga volverá a probar al vencer su espera.
        }
      }
    } finally {
      this.vigilando = false;
    }
  }

  pausar() {
    if (this.fase !== 'descargando') return;
    this.descarga.pausar();
    this.ponerFase('pausado');
  }

  reanudar() {
    if (this.fase !== 'pausado') return;
    this.ponerFase('descargando');
    this.descarga.reanudar();
  }

  falloDisco(e) {
    if (this.descarga) this.descarga.detenerPorDisco(e);
    this.errorDisco = { causa: (e && (e.causa || e.name)) || 'Error', donde: (e && e.donde) || '', mensaje: (e && e.message) || '' };
    this.ponerFase('disco');
  }

  // Desde un clic: puede hacer falta volver a pedir el permiso.
  async reintentarDisco() {
    if ((await this.consultarPermiso()) !== 'granted') {
      let p = 'denied';
      try { p = await this.carpeta.requestPermission({ mode: 'readwrite' }); } catch { /* la carpeta ya no existe */ }
      if (p !== 'granted') {
        this.aviso('El navegador no dio permiso para esa carpeta. Elige otra carpeta para continuar.');
        return;
      }
    }
    await this.comenzar();
  }

  // Todo lo elegido está en la carpeta. Antes de darlo por bueno se mira si el emisor cambió algo.
  async terminar() {
    if (this.terminando) return;
    this.terminando = true;
    try {
      try {
        const st = await this.api.estado(AbortSignal.timeout(8000));
        if (st.manifestSeq !== null && st.manifestSeq !== this.manifiesto.seq) {
          await this.refrescarManifiesto();
          if (this.fase === 'invalido') return;
          if (this.pendientes().length) { this.descarga.replanificar(); return; }
        }
      } catch (e) {
        if (e instanceof ErrorApi && e.clase === 'fatal' && this.alFatal(e)) return;
        // El emisor no responde: lo que tenemos coincide con el último manifiesto conocido.
      }
      if (this.fase !== 'descargando' && this.fase !== 'pausado') return;
      if (this.pendientes().length) { this.descarga.replanificar(); return; }
      this.descarga.detener();
      this.restos = await this.escritor.restos();
      this.hacerResumen();
      this.destinoFinal = this.escritor.registro.destino;
      this.registro.msActivo = this.msActivo;
      this.registro.completada = Date.now();
      // Terminada la transferencia, la página no conserva acceso de escritura a la carpeta.
      this.soltarCarpeta();
      this.guardarRegistro();
      this.hechos = new Map();
      almacen.olvidarHechos(this.enlace.shareIdTexto);
      this.ponerFase('completado');
    } finally {
      this.terminando = false;
    }
  }

  hacerResumen() {
    const t = this.totales();
    this.resumen = {
      archivos: t.hechos, bytes: t.bytesGuardados, ms: this.msActivo,
      verificados: t.verificados, yaEstaban: t.yaEstaban, errores: t.errores, parcial: t.elegidos < t.validos,
    };
  }

  /* ---------------------------------------------------------------- selección */

  pendientes() {
    return this.archivos.filter((a) => a.elegido && !a.error && a.estado !== 'hecho');
  }

  // ids: Set con los archivos elegidos. Si están todos, se recuerda «todo» (incluye los que lleguen después).
  async cambiarSeleccion(ids) {
    const validos = this.archivos.filter((a) => !a.error);
    const todo = validos.every((a) => ids.has(a.id));
    this.seleccion = { todo, ids: new Set(ids) };
    const nuevos = [];
    for (const a of this.archivos) {
      const nuevo = todo || ids.has(a.id);
      if (a.elegido && !nuevo && this.descarga) this.descarga.abortarArchivo(a);
      if (!a.elegido && nuevo && a.segmentos && a.estado !== 'hecho') nuevos.push(a);
      a.elegido = nuevo;
    }
    this.registro.seleccion = { todo, ids: todo ? [] : [...ids] };
    this.guardarRegistro();
    this.versionPlan++;
    if (this.fase === 'completado') {
      if (this.pendientes().length) {
        // La carpeta ya se soltó al terminar: para bajar lo añadido hay que elegirla otra vez.
        this.resumen = null;
        this.pideCarpeta = true;
        this.fase = 'listo';
      } else {
        this.hacerResumen();
      }
    } else if (this.descarga && this.escritor && (this.fase === 'descargando' || this.fase === 'pausado')) {
      if (nuevos.length) {
        // Lo recién elegido se revisa en la carpeta antes de poder descargarse.
        for (const a of nuevos) a.bloqueado = true;
        this.cambio();
        if (!(await this.admitir(nuevos))) return;
      }
      this.descarga.replanificar();
    }
    this.programarInforme();
    this.cambio();
  }

  /* ---------------------------------------------------------------- cifras */

  totales() {
    const t = {
      total: this.archivos.length, bytesTodo: 0, validos: 0, elegidos: 0, bytesTotal: 0, hechos: 0, bytesGuardados: 0,
      bytesVisual: 0, verificados: 0, yaEstaban: 0, errores: 0, recordados: 0,
    };
    for (const a of this.archivos) {
      t.bytesTodo += a.tam;
      if (a.error) { if (a.elegido) t.errores++; continue; }
      t.validos++;
      if (!a.elegido) continue;
      t.elegidos++;
      t.bytesTotal += a.tam;
      t.bytesGuardados += a.guardados;
      if (a.recordado && a.estado !== 'hecho') { t.recordados++; t.bytesVisual += a.tam; } else t.bytesVisual += Math.min(a.tam, a.guardados + a.bytesAbiertos + a.bytesVuelo);
      if (a.estado === 'hecho') {
        t.hechos++;
        if (a.verificado) t.verificados++; else t.yaEstaban++;
      }
    }
    return t;
  }

  /* ---------------------------------------------------------------- reloj, memoria e informes */

  iniciarReloj() {
    clearInterval(this.reloj);
    this.ultimoTic = Date.now();
    this.reloj = setInterval(() => this.tic(), 1000);
  }

  tic() {
    const ahora = Date.now();
    const dt = Math.min(5000, ahora - this.ultimoTic);
    this.ultimoTic = ahora;
    if (this.fase === 'descargando' && this.descarga) {
      if (!this.descarga.puerta) this.msActivo += dt;
      // Velocidad: bytes recibidos por la red en una ventana móvil de 10 s.
      this.muestras.push([ahora, this.descarga.bytesRed]);
      while (this.muestras.length > 1 && ahora - this.muestras[0][0] > VENTANA_MS) this.muestras.shift();
      const ini = this.muestras[0];
      this.velocidad = ahora > ini[0] ? (this.descarga.bytesRed - ini[1]) / ((ahora - ini[0]) / 1000) : 0;
      if (ahora - this.ultimoGuardado > 15000) {
        this.registro.msActivo = this.msActivo;
        this.guardarRegistro();
      }
      if (ahora - this.ultimoSondeo > SONDEO_ESTADO_MS && !this.descarga.puerta && !this.refresco) {
        this.ultimoSondeo = ahora;
        this.sondear();
      }
    }
    const desde = ahora - this.ultimoInforme;
    const finalEntregado = this.fase === 'completado' && this.informeEntregado === 'done';
    if (!finalEntregado && desde >= (this.fase === 'descargando' ? INFORME_MIN_MS : INFORME_REPOSO_MS)) this.programarInforme();
    this.cambio();
  }

  // Mira de vez en cuando si el manifiesto cambió, para rebajar cuanto antes lo que haga falta.
  async sondear() {
    try {
      const st = await this.api.estado();
      if (st.manifestSeq !== null && this.manifiesto && st.manifestSeq !== this.manifiesto.seq) this.refrescarManifiesto();
    } catch (e) {
      if (e instanceof ErrorApi && e.clase === 'fatal') this.alFatal(e);
    }
  }

  // Guarda ya (carpeta, selección, clientId, tiempo). Si hay un guardado en curso, encadena uno más.
  guardarRegistro() {
    this.ultimoGuardado = Date.now();
    if (!this.registro) return;
    if (this.guardando) { this.guardarOtraVez = true; return; }
    this.guardando = true;
    almacen.guardar(this.registro).finally(() => {
      this.guardando = false;
      if (this.guardarOtraVez) { this.guardarOtraVez = false; this.guardarRegistro(); }
    });
  }

  estadoInforme() {
    switch (this.fase) {
      case 'descargando': return this.espera ? 'waiting' : 'downloading';
      case 'pausado': return 'paused';
      case 'completado': return 'done';
      case 'disco': return 'error';
      default: return 'waiting';
    }
  }

  // Informe de avance (sección 6): como mucho uno cada 5 s por pestaña.
  programarInforme() {
    if (!this.api || !this.manifiesto || this.fase === 'invalido' || this.fase === 'cargando') return;
    if (this.informando || this.tInforme) return;
    const falta = INFORME_MIN_MS - (Date.now() - this.ultimoInforme);
    if (falta > 0) {
      this.tInforme = setTimeout(() => { this.tInforme = 0; this.enviarInforme(); }, falta);
      return;
    }
    this.enviarInforme();
  }

  async enviarInforme() {
    if (this.informando || this.fase === 'invalido') return;
    const t = this.totales();
    const informe = {
      clientId: this.registro.clientId,
      state: this.estadoInforme(),
      filesDone: t.hechos, filesTotal: t.elegidos,
      bytesDone: t.bytesGuardados, bytesTotal: t.bytesTotal,   // solo lo verificado y guardado en unidades cerradas
      speed: Math.max(0, Math.round(this.fase === 'descargando' ? this.velocidad : 0)),
      current: this.descarga && this.fase === 'descargando' ? this.descarga.enCurso() : [],
    };
    this.informando = true;
    this.ultimoInforme = Date.now();
    try {
      await this.api.avance(informe);
      this.informeEntregado = informe.state;
    } catch (e) {
      this.informeEntregado = '';
      if (e instanceof ErrorApi && e.clase === 'fatal') this.alFatal(e);
      else if (e instanceof ErrorApi && e.codigo === 'protocolo' && !this.informeRechazado) {
        this.informeRechazado = true;
        console.error('Lata: el emisor rechazó el informe de avance (HTTP ' + e.estado + '); no debería ocurrir.');
      }
      // Cualquier otro fallo: el informe se pierde y ya saldrá el siguiente.
    } finally {
      this.informando = false;
    }
  }

  /* ---------------------------------------------------------------- pruebas */

  instantanea() {
    const t = this.totales();
    const e = this.espera;
    return {
      fase: this.fase,
      motivoInvalido: this.motivoInvalido,
      espera: e ? { motivo: e.motivo, segundos: Math.max(0, Math.ceil((e.hasta - Date.now()) / 1000)) } : null,
      errorDisco: this.errorDisco,
      nombre: this.manifiesto ? this.manifiesto.nombre : '',
      seq: this.manifiesto ? this.manifiesto.seq : null,
      carpeta: this.nombreCarpeta,
      totales: t,
      velocidad: this.velocidad,
      trozosRechazados: this.trozosRechazados,
      seqMax: this.seqMax,
      destino: this.destino,
      colision: this.colision,
      completadaAntes: this.completadaAntes,
      esperasVistas: [...this.esperasVistas],
      modo: this.fijo ? 'fijo' : 'clasico',
      origen: this.origen,
      cambiosOrigen: this.cambiosOrigen,
      seqPuntero: this.fijo ? this.fijo.seq : null,
      consultasPuntero: this.fijo ? this.fijo.consultas : 0,
      punterosAntiguos: this.punterosAntiguos || 0,
      resumen: this.resumen,
      archivos: this.archivos.map((a) => ({
        id: a.id, ruta: a.ruta, tam: a.tam, version: a.version, estado: a.estado, elegido: a.elegido, error: a.error,
        hechas: [...a.hechas].sort((x, y) => x - y), unidades: a.geo ? a.geo.nUnidades : null,
        guardados: a.guardados, verificado: a.verificado, yaEstaba: a.yaEstaba, cambiado: a.cambiado, recordado: a.recordado, adoptado: a.adoptado,
      })),
    };
  }
}
