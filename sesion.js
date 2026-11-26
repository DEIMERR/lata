// La sesión: une el enlace, las claves, el manifiesto, la carpeta, la selección, la descarga y los
// informes de avance, y decide en qué fase está la página. No toca el DOM: la interfaz lee de aquí.
//
// Fases:
//   cargando      derivando claves y pidiendo el manifiesto (con `espera` si el emisor no responde);
//                 en el modo fijo, antes, preguntando al punto de encuentro dónde está el motor
//   invalido      enlace mal formado, revocado o ilegible          → motivoInvalido
//   incompatible  el navegador no tiene showDirectoryPicker
//   otra-pestana  la misma descarga ya está abierta en otra pestaña de este navegador
//   listo         manifiesto cargado, falta elegir carpeta (también si, ya terminada la descarga y con la
//                 página abierta, el emisor añade o cambia archivos → anadidos; entonces la pestaña
//                 conserva en memoria la carpeta de antes y basta un clic para seguir en ella)
//   permiso       hay carpeta recordada pero el navegador pide confirmar el permiso (hace falta un clic)
//   preparando    revisando lo que ya hay en la carpeta (solo lectura hasta saber que no hay choques);
//                 también, con `espera` de motivo «disco», aguardando para reintentar sola una escritura fallida
//   colision      en la carpeta hay archivos ajenos con el mismo nombre y otro tamaño: se pregunta → colision
//   descargando   en marcha; `espera` indica si está esperando al emisor y por qué
//   pausado       en pausa por la persona
//   disco         no se pudo escribir en la carpeta                → errorDisco
//   completado    todo lo elegido está en la carpeta               → resumen
//
// Qué se descarga (la cola): `seleccion`. «Descargar todo» pone todo; el botón de una fila añade ese
// archivo (o lo quita, si aún no ha empezado). Con «todo», lo que el emisor añada después entra solo.
//
// Dos modos (docs/PROTOCOLO.md, sección 10.5):
//   clásico   la página la sirve el propio motor en /s/<shareId>; la API está en el mismo origen.
//   fijo      la página vive en un origen fijo. El shareId y el origen del motor salen de un puntero
//             cifrado que se pide a un punto de encuentro; la API va entre orígenes y, si el motor
//             cambia de dirección, la página lo sigue sola sin perder nada (seguirMotor).

import * as almacen from './almacen.js';
import { crearApi, ErrorApi, esperaProgresiva } from './api.js';
import { Descarga, acotarTrabajadores } from './descarga.js';
import { plural } from './formato.js';
import { abrirPuntero, derivarClavePuntero, derivarIdPuntero, ErrorPuntero, leerModo, pedirPuntero } from './puntero.js';
import {
  abrirManifiesto, bytesAB64u, derivarClaveAcceso, derivarClaveManifiesto, ErrorManifiesto, importarSecreto,
  sanearRutas,
} from './wire.js';

const INFORME_MIN_MS = 5200;      // como mucho un informe cada 5 s (con margen)
const INFORME_REPOSO_MS = 60000;  // sin cambios, un latido por minuto
export const SONDEO_ESTADO_MS = 8000;    // cada cuánto se mira si el emisor cambió la lista (lo añadido se ve en menos de 15 s)
export const SONDEO_CALMA_MS = 600000;   // con la descarga terminada y este tiempo sin novedad, se mira más despacio…
export const SONDEO_LENTO_MS = 60000;    // …una vez por minuto, hasta que algo cambie o la pestaña vuelva a estar a la vista
const VENTANA_MS = 10000;         // ventana móvil de la velocidad
const PUNTERO_MIN_MS = 900;       // modo fijo: como mucho una consulta al punto de encuentro por segundo

// Un manifiesto que no se autentica (un 200 con un cuerpo que no es del emisor) solo da el enlace por
// no válido al abrir, sin que este navegador sepa nada de la compartición, y tras tantas respuestas así.
export const MANIFIESTO_AJENO_MAX = 5;
// Fallos de escritura: causas que necesitan a la persona (disco lleno, permiso retirado, carpeta
// desaparecida). Cualquier otra se da por pasajera (un antivirus o la sincronización con la nube
// tienen el archivo cogido) y se reintenta sola.
export const DISCO_DEFINITIVO = ['QuotaExceededError', 'NotAllowedError', 'SecurityError', 'NotFoundError'];
export const DISCO_REINTENTOS = 5;      // reintentos seguidos (2, 4, 8, 16 y 30 s) antes de pedir atención
export const DISCO_LENTO_S = 120;       // ya en la fase «disco», se sigue probando sola cada tanto

export const esDiscoPasajero = (causa) => !DISCO_DEFINITIVO.includes(causa);

// ¿Un manifiesto ilegible da el enlace por no válido? Solo al abrir (a mitad de descarga, nunca) y:
//   - si es del emisor pero no cumple el protocolo, enseguida: esperar no lo arregla;
//   - si no se autentica, solo cuando nada indica que el enlace sea bueno (`probado`: este navegador
//     ya abrió antes una lista con él, o el puntero del modo fijo se abrió con él) y se ha repetido
//     MANIFIESTO_AJENO_MAX veces. Con un secreto equivocado el motor responde 401, no esto.
export function manifiestoFatal({ autentico, hayManifiesto, probado, veces }) {
  if (hayManifiesto) return false;
  if (autentico) return true;
  if (probado) return false;
  return veces >= MANIFIESTO_AJENO_MAX;
}

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
    nuevo: false,       // el emisor lo añadió con la página ya abierta
  };
}

// ¿Hay una descarga en marcha (o en pausa) con su carpeta? Entonces la cola se puede cambiar sin preguntar.
const enMarcha = (s) => !!s.descarga && !!s.escritor && (s.fase === 'descargando' || s.fase === 'pausado');

// Un archivo en cola del que todavía no se ha pedido ni guardado nada: se puede quitar sin dejar restos.
const sinEmpezar = (a) => a.estado === 'cola' && a.activas.size === 0 && a.hechas.size === 0
  && a.guardados === 0 && a.bytesAbiertos === 0 && a.bytesVuelo === 0;

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
    this.finPrevio = false;           // esta página terminó una descarga y sigue abierta (conserva la carpeta solo en memoria)
    this.abriendo = false;            // se está decidiendo en qué carpeta seguir (la de memoria o la ventana del navegador)
    this.retiradosEnCarpeta = new Map(); // id → ruta de lo que el emisor retiró cuando ya estaba descargado: sigue en la carpeta
    this.retiradosDeCola = 0;         // archivos retirados por el emisor mientras estaban en la cola de esta descarga
    this.colaVacia = '';              // la descarga se quedó sin nada que bajar: 'retirado' (lo retiró el emisor) o 'quitado'
    this.novedad = Date.now();        // última vez que cambió algo (fase, lista) o que la pestaña volvió a estar a la vista
    this.anadidos = new Set();        // ids de lo que el emisor ha añadido desde entonces: «Descargar lo nuevo»
    this.eligiendo = false;           // la ventana de elegir carpeta está abierta
    this.admision = Promise.resolve(); // revisiones en la carpeta de lo que entra en la cola, de una en una
    this.sondeando = false;
    this.fallosSondeo = 0;            // consultas de estado seguidas sin respuesta: se espacian
    this.enlaceCerrado = false;       // con la descarga terminada el enlace dejó de valer: ya no se pregunta nada
    this.nombreCarpetaFinal = '';
    this.trozosRechazados = 0;
    // Modo fijo (sección 10). `fijo` es null en el modo clásico.
    //   { encuentro, id (16 bytes), idTexto, clave, seq (mayor visto), pidiendo, ultima, consultas }
    this.reintentosDisco = 0;         // fallos de escritura pasajeros seguidos (se pone a cero al cerrar una unidad)
    this.reintentosAuto = 0;          // veces que la página ha reintentado sola tras un fallo de escritura
    this.esperaDisco = null;          // { motivo: 'disco', hasta, segundos, causa }: cuenta atrás del reintento automático
    this.turnoDisco = 0;              // cambia con cada fallo o reinicio: un reintento pendiente de otro turno no hace nada
    this.atendiendoDisco = false;
    this.relevos = 0;                 // veces que esta pestaña ha tomado el relevo de otra que se cerró
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
    this.novedad = Date.now();
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
    if (this.esperaDisco && ['preparando', 'disco'].includes(this.fase)) return this.esperaDisco;
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
      if (!libre) {
        // Otra pestaña lleva esta descarga. Se espera a que la cierre (o suelte el relevo) y entonces
        // esta lo toma sola y sigue, sin ningún clic: la petición queda en cola hasta que haya sitio.
        this.ponerFase('otra-pestana');
        await new Promise((res) => {
          navigator.locks.request('lata-' + enlace.shareIdTexto, () => {
            res();
            return new Promise(() => {}); // desde ahora la lleva esta pestaña
          }).catch(() => res());
        });
        if (this.fase !== 'otra-pestana') return false;
        this.relevos++;
        this.ponerFase('cargando');
      }
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
    // Con la descarga terminada y la carpeta suelta, que el enlace deje de valer no cambia nada de lo
    // descargado: la pantalla final se queda como está y la página deja de preguntar al emisor.
    if (this.fase === 'completado') {
      this.enlaceCerrado = true;
      this.soltarCarpeta();   // tampoco se conserva ya la carpeta en memoria
      return false;
    }
    this.motivoInvalido = motivo;
    this.esperaCarga = null;
    this.esperaManifiesto = null;
    this.esperaDisco = null;
    this.turnoDisco++;
    this.colision = null;
    if (this.descarga) this.descarga.detener();
    this.soltarCarpeta();
    clearInterval(this.reloj);
    clearTimeout(this.tInforme);
    this.fase = 'invalido';
    this.cambio();
    return false;
  }

  // Deja de tener acceso a la carpeta: fuera de IndexedDB y de la memoria. Se hace ante un enlace no
  // válido o revocado (401).
  // Al completar la descarga (`enMemoria`) el identificador se borra igualmente de IndexedDB: la página
  // no GUARDA acceso de escritura más allá de la transferencia (protocolo, sección 8). Lo que sí
  // conserva, solo en la memoria de esta pestaña y mientras siga abierta, es el identificador que ya
  // tenía, para que bajar otro archivo después no obligue a elegir la carpeta otra vez. Al cerrar o
  // recargar la pestaña desaparece, y solo se usa si el navegador mantiene el permiso (queryPermission).
  soltarCarpeta(enMemoria = false) {
    if (this.carpeta) this.nombreCarpetaFinal = this.carpeta.name || '';
    if (!enMemoria) this.carpeta = null;
    this.escritor = null;
    this.descarga = null;
    if (this.registro && this.registro.carpeta) {
      this.registro.carpeta = null;
      this.guardarRegistro();
    }
  }

  // ¿Hay algo que diga que este enlace es bueno? Este navegador ya abrió una lista con él (o tiene una
  // carpeta o una descarga terminada apuntadas), o el puntero del modo fijo se abrió con su secreto.
  enlaceProbado() {
    const r = this.registro;
    return !!this.fijo || this.seqMax > 0 || !!(r && (r.carpeta || r.completada));
  }

  // Pide y abre el manifiesto. Reintenta sin límite mientras el fallo sea de red o de espera, y también
  // si llega un cuerpo que no se puede leer con la descarga ya en marcha (ver manifiestoFatal).
  async cargarManifiesto() {
    let mudanzas = this.cambiosOrigen;
    let ilegibles = 0;
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
        const ilegible = e instanceof ErrorManifiesto;
        if (ilegible) {
          ilegibles++;
          if (manifiestoFatal({ autentico: e.autentico, hayManifiesto: !!this.manifiesto, probado: this.enlaceProbado(), veces: ilegibles })) return this.invalidar('manifiesto');
          if (e.autentico) console.error('Lata: el emisor envió una lista de archivos que no cumple el protocolo (' + e.message + '); se vuelve a pedir.');
        }
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
        // Un cuerpo que no es del emisor (o que no cumple el protocolo): se descarta y se vuelve a pedir.
        if (ilegible) motivo = e.autentico ? 'protocolo' : 'manifiesto-ajeno';
        if (e instanceof ErrorApi && e.clase === 'espera') { segundos = e.espera; motivo = e.codigo; } else segundos = esperaProgresiva(++intento);
        if (!this.manifiesto) {
          this.esperaCarga = { motivo, hasta: Date.now() + segundos * 1000, segundos };
          this.esperasVistas.add(motivo);
          this.cambio();
        } else if (motivo === 'antiguo' || ilegible) {
          this.esperaManifiesto = { motivo, hasta: Date.now() + segundos * 1000, segundos };
          this.esperasVistas.add(motivo);
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
    const primera = !this.manifiesto;
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
    // Lo que el emisor ha retirado: deja la lista y la cola. Si se estaba bajando, se corta sin más (no
    // es un fallo) y se quitan sus partes a medias. Lo que ya estaba descargado NO se toca: la página
    // nunca borra un archivo terminado; solo se apunta que sigue en la carpeta.
    const ids = new Set(m.archivos.map((f) => f.id));
    const retirados = [...antes.values()].filter((v) => !ids.has(v.id));
    sustituidos.push(...retirados);
    for (const v of sustituidos) if (this.descarga) this.descarga.abortarArchivo(v);
    if (this.descarga && sustituidos.length) await this.descarga.enCalma();   // lo abierto ya está cerrado y descartado
    // Se mira cómo ha quedado cada uno DESPUÉS de cortar: un archivo que justo terminaba de cerrarse
    // entero se ha conservado y cuenta como descargado, igual que los que ya lo estaban.
    for (const v of retirados) {
      if (v.estado === 'hecho') this.retiradosEnCarpeta.set(v.id, v.ruta);
      else if (enMarcha(this) && v.elegido && !v.error) this.retiradosDeCola++;
    }
    for (const v of sustituidos) {
      // Un archivo que se está uniendo en este instante se deja terminar: él mismo quita sus partes.
      if (this.escritor && v.segmentos && !cambioTrozo && v.estado !== 'ensamblando') await this.escritor.descartar(v).catch(() => {});
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
    if (!primera && !mismo) this.novedad = Date.now();
    // Lo que el emisor ha añadido con la página abierta: se avisa. Si se descarga todo, entra solo en la
    // cola (ya está elegido); si solo se eligieron algunos, queda en la lista con su botón.
    const anadidos = primera ? [] : lista.filter((a) => !antes.has(a.id) && a.segmentos);
    for (const a of anadidos) {
      a.nuevo = true;
      this.retiradosEnCarpeta.delete(a.id);   // lo retiró y lo ha vuelto a poner
      if (this.finPrevio) this.anadidos.add(a.id);
    }
    // Un solo aviso para lo añadido y lo retirado en la misma tanda.
    const partes = [];
    if (anadidos.length) partes.push(`añadido ${plural(anadidos.length, 'archivo', 'archivos')}`);
    if (retirados.length) partes.push(`retirado ${plural(retirados.length, 'archivo', 'archivos')}`);
    if (partes.length) this.aviso('Han ' + partes.join(' y han '));
    const nuevos = lista.filter((a) => !conservados.has(a) && a.segmentos);
    if (enMarcha(this) && !cambioTrozo && nuevos.length) {
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
    // Con la descarga terminada, lo añadido puede estar ya en la carpeta (el emisor lo retiró y lo ha
    // vuelto a poner): se mira antes de ofrecer bajarlo.
    if (this.finPrevio && anadidos.length) await this.reconocerEnCarpeta(anadidos);
    // Ya había terminado y ahora hay algo más que bajar (añadido o cambiado): deja de estar completa.
    // No hay descarga en marcha: hace falta un clic para seguir (en la carpeta que la pestaña conserva).
    const falta = this.nuevosPendientes().length > 0 || this.pendientes().length > 0;
    if (this.fase === 'completado' && falta) {
      this.resumen = null;
      this.ponerFase('listo');
    } else if (this.fase === 'listo' && this.finPrevio && !falta) {
      // El emisor ha retirado lo que añadió: vuelve a estar todo.
      this.hacerResumen();
      this.ponerFase('completado');
    } else if (this.fase === 'completado' && !primera && !mismo) {
      // Sigue completa (retiraron algo, o lo añadido ya estaba): el resumen cuenta lo que hay ahora en la lista.
      this.hacerResumen();
    }
    this.cambio();
  }

  // Solo lectura. Con la descarga terminada y la carpeta todavía en la memoria de la pestaña (y con el
  // permiso concedido), mira si esos archivos ya están en ella con el tamaño exacto: entonces son
  // «Ya estaba» y no hay nada que ofrecer. Si no se puede mirar, no pasa nada: se verá al descargarlos.
  async reconocerEnCarpeta(archivos) {
    if (!this.carpeta || this.escritor || this.descarga) return;
    try {
      if ((await this.consultarPermiso()) !== 'granted') return;
      const e = this.op.crearEscritor(this.carpeta, this.manifiesto.tamTrozo, this.enlace.shareIdTexto);
      await e.cargarRegistro();
      const d = this.destinoFinal;
      if (!e.registroEnDisco && typeof d === 'string' && d !== '' && (await e.existeCarpeta(d))) e.fijarDestino(d);
      const estados = await e.revisar(archivos);
      for (const a of archivos) {
        const r = estados.get(a.id);
        if (!r || !r.completo || this.porId.get(a.id) !== a) continue;
        a.estado = 'hecho';
        a.guardados = a.tam;
        a.verificado = false;
        a.yaEstaba = true;
        a.nuevo = false;
      }
    } catch { /* la carpeta no se deja leer ahora: se ofrecerá descargarlos y se verá entonces */ }
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
  // `seleccion`: qué se va a descargar en esa carpeta (null = todo, o un Set de ids); sin él, lo que
  // ya estaba elegido. Solo se aplica si se llega a elegir carpeta: cancelar la ventana no cambia nada.
  async elegirCarpeta(seleccion) {
    if (this.eligiendo) return false;
    let carpeta;
    this.eligiendo = true;
    try {
      carpeta = await this.op.elegirCarpeta();
    } catch (e) {
      if (e && e.name === 'AbortError') return false; // cerró la ventana sin elegir
      this.aviso('No se pudo usar esa carpeta. El navegador no deja usar carpetas del sistema: crea una carpeta nueva y elígela.');
      return false;
    } finally {
      this.eligiendo = false;
    }
    if (!carpeta) return false;
    // Si es otra carpeta, lo que se sabía de la anterior ya no vale.
    let misma = false;
    try { misma = !!this.carpeta && (await this.carpeta.isSameEntry(carpeta)); } catch { /* se trata como distinta */ }
    await this.usarCarpeta(carpeta, misma, seleccion);
    return true;
  }

  // Empieza (o sigue) en esa carpeta. `misma`: es la que ya se estaba usando.
  async usarCarpeta(carpeta, misma, seleccion) {
    if (this.descarga) { this.descarga.detener(); this.descarga = null; }
    this.escritor = null;
    if (seleccion !== undefined) this.fijarSeleccion(seleccion);
    for (const a of this.archivos) {
      a.geo = null;
      if (!misma) { a.verificado = false; a.yaEstaba = false; }
    }
    if (!misma) {
      this.hechos = new Map();
      almacen.olvidarHechos(this.enlace.shareIdTexto);
      this.retiradosEnCarpeta.clear();
    }
    this.carpeta = carpeta;
    this.reintentosDisco = 0;
    this.simularPermiso = false;
    this.completadaAntes = false;
    this.registro.carpeta = carpeta;
    this.registro.completada = 0;
    this.guardarRegistro();
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch { /* opcional */ }
    await this.comenzar();
  }

  // Descarga `seleccion` (null = todo, o un Set de ids) cuando no hay ninguna descarga en marcha. Desde
  // un clic. Si esta pestaña ya terminó una descarga y conserva su carpeta en memoria, y el navegador
  // mantiene el permiso, sigue en ella sin preguntar nada; si no, el navegador enseña su ventana.
  async descargarEn(seleccion) {
    if (this.abriendo || (this.fase !== 'listo' && this.fase !== 'completado')) return false;
    this.abriendo = true;
    try {
      if (this.carpeta && (await this.consultarPermiso()) === 'granted') {
        await this.usarCarpeta(this.carpeta, true, seleccion);
        return true;
      }
      return await this.elegirCarpeta(seleccion);
    } finally {
      this.abriendo = false;
    }
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
    this.esperaDisco = null;
    this.turnoDisco++;
    this.resumen = null;
    this.colision = null;
    this.finPrevio = false;
    this.anadidos.clear();
    this.retiradosDeCola = 0;
    this.colaVacia = '';
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
    this.recordarTodoSiNoFaltaNada();
    this.descarga = new Descarga({
      claveBase: this.claveBase, credencial: this.credencial, shareIdTexto: this.enlace.shareIdTexto, shareId: this.enlace.shareId,
      tamTrozo: this.manifiesto.tamTrozo, escritor: this.escritor, trabajadores: acotarTrabajadores(this.op.trabajadores),
      sinDatosMs: this.op.sinDatosMs, urlTrabajador: this.op.urlTrabajador, origen: this.origen, fijo: !!this.fijo,
      plazoListoMs: this.op.plazoListoMs, plazoTrabajoMs: this.op.plazoTrabajoMs, plazoEscrituraMs: this.op.plazoEscrituraMs,
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

  // Vista la carpeta: si entre lo que está en la cola y lo que ya está en ella no queda fuera ningún
  // archivo, es lo mismo que haberlo elegido todo, y lo que el emisor añada después entrará solo.
  recordarTodoSiNoFaltaNada() {
    if (this.seleccion.todo || !this.archivos.every((a) => a.error || a.elegido || a.estado === 'hecho')) return;
    this.seleccion = { todo: true, ids: new Set() };
    for (const a of this.archivos) a.elegido = true;
    this.registro.seleccion = { todo: true, ids: [] };
    this.guardarRegistro();
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

  // Archivos que entran con la descarga ya en marcha (manifiesto nuevo o cola ampliada): se revisan
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
      case 'unidad':
        this.reintentosDisco = 0;   // se ha cerrado una unidad entera: la carpeta vuelve a dejarse escribir
        break;
      case 'archivo-hecho':
        this.reintentosDisco = 0;
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

  // No se pudo escribir en la carpeta. Si la causa necesita a la persona (disco lleno, permiso
  // retirado, carpeta desaparecida), la descarga se detiene en la fase «disco» y espera un clic. Si
  // parece pasajera (otro programa tiene el archivo cogido, o una escritura se quedó colgada), se
  // reintenta sola: DISCO_REINTENTOS veces seguidas con espera progresiva y, si sigue igual, se pasa
  // a la fase «disco» pero se sigue probando cada DISCO_LENTO_S. Lo ya guardado no se pierde nunca:
  // cada reintento vuelve a leer la carpeta y continúa desde lo que hay.
  falloDisco(e) {
    if (this.atendiendoDisco || this.fase === 'invalido') return;
    // Parar la descarga avisa a su vez de este mismo fallo: no se cuenta dos veces.
    this.atendiendoDisco = true;
    try { if (this.descarga) this.descarga.detenerPorDisco(e); } finally { this.atendiendoDisco = false; }
    const err = { causa: (e && (e.causa || e.name)) || 'Error', donde: (e && e.donde) || '', mensaje: (e && e.message) || '' };
    const turno = ++this.turnoDisco;
    const enPausa = this.fase === 'pausado';
    // Una escritura colgada puede haber dejado al escritor a medias: el siguiente intento usa uno nuevo,
    // que reconstruye todo desde lo que hay en la carpeta.
    if (err.causa === 'Plazo') this.escritor = null;
    const pasajero = esDiscoPasajero(err.causa) && !!this.carpeta && !!this.manifiesto;
    if (pasajero && this.reintentosDisco < DISCO_REINTENTOS) {
      this.reintentosDisco++;
      console.warn(`Lata: no se pudo escribir en la carpeta (${err.causa}, ${err.donde}); reintento ${this.reintentosDisco} de ${DISCO_REINTENTOS}.`);
      this.errorDisco = null;
      this.reintentarDiscoSolo(err, turno, esperaProgresiva(this.reintentosDisco + 1), 'preparando', enPausa);
      return;
    }
    this.errorDisco = err;
    this.esperaDisco = null;
    this.ponerFase('disco');
    if (pasajero) this.reintentarDiscoSolo(err, turno, DISCO_LENTO_S, 'disco', enPausa);
  }

  // Espera y vuelve a empezar sola (comenzar() relee la carpeta). `fase` es la que se enseña mientras
  // tanto: «preparando» en los primeros reintentos, «disco» en los lentos. Si entre tanto pasa
  // cualquier otra cosa (un clic, otra carpeta, otro fallo), este intento ya no hace nada.
  async reintentarDiscoSolo(err, turno, segundos, fase, enPausa) {
    const unidad = this.op.discoUnidadMs || 1000;
    this.esperaDisco = { motivo: 'disco', hasta: Date.now() + segundos * unidad, segundos, causa: err.causa };
    this.esperasVistas.add('disco');
    this.fase = fase;   // sin ponerFase: si ya es esa fase, hay que repintar igual
    this.muestras = [];
    this.velocidad = 0;
    this.programarInforme();
    this.cambio();
    await this.dormir(segundos * unidad);
    if (turno !== this.turnoDisco || this.fase !== fase) return;
    if ((await this.consultarPermiso()) !== 'granted') {
      // Sin permiso no hay reintento posible sin la persona: el navegador solo lo pide tras un clic.
      if (turno !== this.turnoDisco || this.fase !== fase) return;
      this.esperaDisco = null;
      this.errorDisco = { causa: 'NotAllowedError', donde: err.donde, mensaje: '' };
      this.fase = 'disco';
      this.cambio();
      return;
    }
    if (turno !== this.turnoDisco || this.fase !== fase) return;
    this.reintentosAuto++;
    await this.comenzar();
    // Si la persona la tenía en pausa, sigue en pausa.
    if (enPausa && this.fase === 'descargando') this.pausar();
  }

  // Desde un clic: puede hacer falta volver a pedir el permiso.
  async reintentarDisco() {
    this.turnoDisco++;          // anula el reintento automático que estuviera esperando
    this.esperaDisco = null;
    this.reintentosDisco = 0;
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
      if (!this.archivos.some((a) => a.elegido)) {
        // La cola se ha quedado sin nada: el emisor retiró lo que se había elegido (o la persona lo quitó
        // todo). No hay nada que dar por terminado: se vuelve a la pantalla inicial, que lo explica. La
        // carpeta se trata como al terminar: fuera de IndexedDB, y en la memoria de la pestaña.
        await this.escritor.restos();
        this.colaVacia = this.retiradosDeCola > 0 || this.retiradosEnCarpeta.size > 0 ? 'retirado' : 'quitado';
        this.registro.msActivo = this.msActivo;
        this.soltarCarpeta(true);
        this.guardarRegistro();
        this.ponerFase('listo');
        return;
      }
      this.restos = await this.escritor.restos();
      this.hacerResumen();
      this.destinoFinal = this.escritor.registro.destino;
      this.registro.msActivo = this.msActivo;
      this.registro.completada = Date.now();
      // Terminada la transferencia, la página no guarda acceso de escritura a la carpeta (IndexedDB).
      // El identificador se queda solo en la memoria de esta pestaña, por si se baja algo más.
      this.soltarCarpeta(true);
      this.guardarRegistro();
      this.hechos = new Map();
      almacen.olvidarHechos(this.enlace.shareIdTexto);
      this.finPrevio = true;
      this.ponerFase('completado');
    } finally {
      this.terminando = false;
    }
  }

  hacerResumen() {
    const t = this.totales();
    this.resumen = {
      archivos: t.hechos, bytes: t.bytesGuardados, ms: this.msActivo,
      verificados: t.verificados, yaEstaban: t.yaEstaban, errores: t.errores,
    };
  }

  /* ---------------------------------------------------------------- qué se descarga (la cola) */

  pendientes() {
    return this.archivos.filter((a) => a.elegido && !a.error && a.estado !== 'hecho');
  }

  // Lo que el emisor añadió después de terminar y aún no está descargado.
  nuevosPendientes() {
    const lista = [];
    for (const id of this.anadidos) {
      const a = this.porId.get(id);
      if (a && !a.error && a.estado !== 'hecho') lista.push(a);
    }
    return lista;
  }

  // Qué ofrece el botón de la fila de un archivo: 'descargar', 'quitar' (sacarlo de la cola) o '' (nada).
  //   - sin carpeta todavía (o ya terminada la descarga): descargar; pedirá la carpeta;
  //   - con la descarga en marcha: descargar lo que no está en la cola, y quitar lo que está en cola y
  //     aún no ha empezado. Lo que ya está bajando o bajado no ofrece nada.
  // En las demás fases la página necesita antes otra cosa (un permiso, una decisión, reintentar).
  accionFila(a) {
    if (a.error || a.estado === 'hecho') return '';
    if (enMarcha(this)) {
      if (!a.elegido) return 'descargar';
      return sinEmpezar(a) ? 'quitar' : '';
    }
    return this.fase === 'listo' || this.fase === 'completado' ? 'descargar' : '';
  }

  // Botón de una fila. Desde un clic: sin carpeta, el navegador enseña su ventana y después se descarga
  // solo ese archivo; con carpeta (en marcha, o la que esta pestaña conserva de la descarga anterior),
  // entra en la cola (o sale de ella) sin preguntar nada.
  async alternarArchivo(id) {
    const a = this.porId.get(id);
    const que = a ? this.accionFila(a) : '';
    if (!que) return false;
    if (!enMarcha(this)) return this.descargarEn(new Set([id]));
    const ids = new Set(this.archivos.filter((x) => x.elegido && !x.error).map((x) => x.id));
    if (que === 'quitar') ids.delete(id); else ids.add(id);
    await this.cambiarSeleccion(ids);
    return true;
  }

  // Botón principal: todo lo que falte. Lo que ya está en la carpeta no se vuelve a bajar.
  async descargarTodo() {
    if (enMarcha(this)) {
      await this.cambiarSeleccion(null);
      return true;
    }
    return this.descargarEn(null);
  }

  // «Descargar lo nuevo»: SOLO lo que el emisor añadió después de terminar, sea cual sea la carpeta.
  // Lo que ya se descargó no entra en la cola: en la misma carpeta saldrá como «Ya estaba», y en otra
  // sencillamente no está (queda disponible con su botón y con «Descargar lo que falta»).
  async descargarNuevo() {
    const nuevos = this.nuevosPendientes();
    if (this.fase !== 'listo' || !nuevos.length) return false;
    return this.descargarEn(new Set(nuevos.map((a) => a.id)));
  }

  // Fija qué archivos están en la cola. ids: Set, o null para «todo» (incluye lo que llegue después).
  // Si con esos ids no queda fuera nada de lo que falta por bajar, también se recuerda «todo». Lo que
  // «ya está» solo se da por sabido con la carpeta delante: sin ella puede que se elija otra distinta,
  // y entonces pulsar una fila no debe traer consigo nada más que ese archivo.
  // Devuelve los archivos que entran en la cola con el cambio.
  fijarSeleccion(ids) {
    const conCarpeta = enMarcha(this);
    const todo = ids === null || this.archivos.every((a) => a.error || ids.has(a.id) || (conCarpeta && a.estado === 'hecho'));
    this.seleccion = { todo, ids: todo ? new Set() : new Set(ids) };
    const entran = [];
    for (const a of this.archivos) {
      const elegido = todo || ids.has(a.id);
      if (a.elegido && !elegido) {
        if (this.descarga) this.descarga.abortarArchivo(a);
        a.bloqueado = false;
      }
      if (!a.elegido && elegido && a.segmentos && a.estado !== 'hecho') entran.push(a);
      a.elegido = elegido;
    }
    this.registro.seleccion = { todo, ids: [...this.seleccion.ids] };
    this.guardarRegistro();
    this.versionPlan++;
    return entran;
  }

  // Cambia la cola con la descarga en marcha. Lo que entra se revisa en la carpeta antes de poder
  // descargarse (podría chocar con un archivo ajeno); las revisiones van de una en una.
  async cambiarSeleccion(ids) {
    const entran = this.fijarSeleccion(ids);
    if (enMarcha(this)) {
      const descarga = this.descarga;
      for (const a of entran) a.bloqueado = true;
      this.programarInforme();
      this.cambio();   // la fila cambia ya, sin esperar a la carpeta
      this.admision = this.admision.catch(() => {}).then(async () => {
        if (this.descarga !== descarga || !enMarcha(this)) return;
        const lista = entran.filter((a) => a.elegido && a.bloqueado && this.porId.get(a.id) === a);
        if (lista.length && !(await this.admitir(lista))) return;
        if (this.descarga === descarga) descarga.replanificar();
      });
      await this.admision;
    }
    this.programarInforme();
    this.cambio();
  }

  /* ---------------------------------------------------------------- cifras */

  // Cuenta lo que está en la cola y lo que ya está en la carpeta aunque no se eligiera (se encontró
  // al revisarla). Con `todo`, cuenta todos los archivos: es lo que ofrece el botón principal.
  totales(todo = false) {
    const t = {
      total: this.archivos.length, bytesTodo: 0, validos: 0, elegidos: 0, bytesTotal: 0, hechos: 0, bytesGuardados: 0,
      bytesVisual: 0, verificados: 0, yaEstaban: 0, errores: 0, recordados: 0,
    };
    for (const a of this.archivos) {
      t.bytesTodo += a.tam;
      if (a.error) { if (a.elegido || todo) t.errores++; continue; }
      t.validos++;
      if (!todo && !a.elegido && a.estado !== 'hecho') continue;
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
    this.ultimoSondeo = this.ultimoTic;
    this.reloj = setInterval(() => this.tic(), 1000);
  }

  tic() {
    const ahora = Date.now();
    const dt = Math.min(5000, ahora - this.ultimoTic);
    this.ultimoTic = ahora;
    if (this.enlaceCerrado) return;
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
    }
    if (this.tocaSondear(ahora)) {
      this.ultimoSondeo = ahora;
      this.sondear();
    }
    const desde = ahora - this.ultimoInforme;
    const finalEntregado = this.fase === 'completado' && this.informeEntregado === 'done';
    if (!finalEntregado && desde >= (this.fase === 'descargando' ? INFORME_MIN_MS : INFORME_REPOSO_MS)) this.programarInforme();
    this.cambio();
  }

  // ¿Toca mirar si el emisor cambió la lista? Mientras la página enseña la lista y puede hacer algo con
  // ella: antes de empezar, descargando, en pausa y ya terminada (el emisor puede añadir archivos
  // después). No mientras la descarga espera al emisor: entonces ya se le pregunta por otro lado.
  // Si el emisor no responde, las consultas se espacian (hasta una cada 48 s). Y con la descarga
  // terminada, tras SONDEO_CALMA_MS sin ninguna novedad, se pasa a una por minuto: una pestaña olvidada
  // no tiene por qué preguntar cada pocos segundos. Vuelve al ritmo normal en cuanto algo cambia o la
  // pestaña vuelve a estar a la vista (alVolver).
  tocaSondear(ahora) {
    if (!this.manifiesto || this.refresco || this.sondeando || this.enlaceCerrado) return false;
    if (!['listo', 'descargando', 'pausado', 'completado'].includes(this.fase)) return false;
    if (this.fase === 'descargando' && this.descarga && this.descarga.puerta) return false;
    const calma = this.fase === 'completado' && ahora - this.novedad > SONDEO_CALMA_MS;
    const cada = Math.max(calma ? SONDEO_LENTO_MS : 0, SONDEO_ESTADO_MS * (1 + Math.min(5, this.fallosSondeo)));
    return ahora - this.ultimoSondeo > cada;
  }

  // La pestaña vuelve a estar a la vista: se mira la lista al ritmo normal otra vez.
  alVolver() { this.novedad = Date.now(); }

  // Mira si el manifiesto cambió, para enseñar lo añadido y rebajar cuanto antes lo que haga falta.
  async sondear() {
    this.sondeando = true;
    try {
      const st = await this.api.estado(AbortSignal.timeout(8000));
      this.fallosSondeo = 0;
      if (st.manifestSeq !== null && this.manifiesto && st.manifestSeq !== this.manifiesto.seq) this.refrescarManifiesto();
    } catch (e) {
      this.fallosSondeo++;
      if (e instanceof ErrorApi && e.clase === 'fatal') this.alFatal(e);
    } finally {
      this.sondeando = false;
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
      carpetaEnMemoria: !!this.carpeta,
      colision: this.colision,
      completadaAntes: this.completadaAntes,
      seleccionTodo: this.seleccion.todo,
      retiradosEnCarpeta: [...this.retiradosEnCarpeta.values()],
      colaVacia: this.colaVacia,
      anadidos: this.nuevosPendientes().map((a) => a.id),
      esperasVistas: [...this.esperasVistas],
      reintentosDisco: this.reintentosDisco,
      reintentosAuto: this.reintentosAuto,
      relevos: this.relevos,
      trabajadoresRepuestos: this.descarga ? this.descarga.fallosTrabajador : 0,
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
        nuevo: a.nuevo, accion: this.accionFila(a),
      })),
    };
  }
}
