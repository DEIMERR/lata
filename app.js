// Punto de entrada de la página receptora: crea la sesión y la interfaz y las une.
// También: mantener la pantalla encendida, avisar antes de cerrar y el gancho para pruebas.

import { ENCUENTRO } from './config.js';
import { ErrorDisco, EscritorPartes } from './escritor.js';
import { Sesion } from './sesion.js';
import { crearInterfaz } from './ui.js';

const params = new URLSearchParams(location.search);

// Gancho de pruebas: SOLO con ?prueba=1 y SOLO en 127.0.0.1 o localhost. En cualquier otro sitio
// `prueba` es false y nada de lo que cuelga de él se ejecuta ni se publica en window.
const esLocal = location.hostname === '127.0.0.1' || location.hostname === 'localhost';
const prueba = esLocal && params.get('prueba') === '1';
// falloDisco: nombre del error que dará la siguiente escritura (y las falloDiscoVeces - 1 siguientes);
// cuelgueDisco: número de escrituras que se quedarán colgadas sin terminar nunca;
// cancelarCarpeta: número de veces que la ventana de elegir carpeta se cerrará sin elegir nada;
// carpeta: nombre de la carpeta de pruebas que «elegirá» la ventana a partir de ahora (en vez de la del enlace);
// cierreLento: { id, ms, fallo } → al cerrar el archivo o la parte de ese fileId, el cierre tarda `ms` y, si
// se da `fallo` (nombre de error), en vez de cerrarse se interrumpe con ese error.
const ajustes = { falloDisco: '', falloDiscoVeces: 1, cuelgueDisco: 0, cancelarCarpeta: 0, carpeta: '', cierreLento: null };
const cierres = [];   // cierres retrasados por `cierreLento`: { id, inicio, fin, resultado, abortado } (para las pruebas)
let carpetasPedidas = 0;   // veces que se ha abierto la ventana de elegir carpeta (para las pruebas)
const milis = (nombre, minimo) => (prueba && Number(params.get(nombre)) >= minimo ? Number(params.get(nombre)) : undefined);

// La página fija no puede enviar cabeceras propias, y `frame-ancestors` no vale en una etiqueta <meta>:
// si está dentro de un marco, no funciona (ni lee el enlace, ni pide nada). Vale también para la copia
// que sirve el motor, que además lo prohíbe con su cabecera.
const enMarco = (() => { try { return window.top !== window.self; } catch { return true; } })();

function elegirCarpeta() {
  if (prueba) {
    carpetasPedidas++;
    if (ajustes.cancelarCarpeta > 0) {
      ajustes.cancelarCarpeta--;
      return Promise.reject(new DOMException('ventana cerrada sin elegir', 'AbortError'));
    }
    // En pruebas la carpeta sale del almacenamiento privado del navegador (OPFS), sin ventana de selección.
    const pedido = ajustes.carpeta || params.get('carpeta') || '';
    const nombre = /^[a-z0-9-]{1,40}$/.test(pedido) ? pedido : 'prueba';
    return navigator.storage.getDirectory().then((raiz) => raiz.getDirectoryHandle('lata-' + nombre, { create: true }));
  }
  return window.showDirectoryPicker({ id: 'lata', mode: 'readwrite', startIn: 'downloads' });
}

function crearEscritor(carpeta, tamTrozo, shareIdTexto) {
  const e = new EscritorPartes(carpeta, tamTrozo, shareIdTexto);
  if (prueba) {
    // Permite simular un fallo de disco en la siguiente escritura (ajustar({ falloDisco: 'QuotaExceededError' })),
    // repetido (falloDiscoVeces), o una escritura que no termina nunca (cuelgueDisco).
    const abrir = e.abrirUnidad.bind(e);
    e.abrirUnidad = async (a, k) => {
      const u = await abrir(a, k);
      const escribir = u.escribir.bind(u);
      u.escribir = async (pos, datos) => {
        if (ajustes.cuelgueDisco > 0) {
          ajustes.cuelgueDisco--;
          return new Promise(() => {});
        }
        if (ajustes.falloDisco) {
          const nombre = ajustes.falloDisco;
          ajustes.falloDiscoVeces = Math.max(0, (Number(ajustes.falloDiscoVeces) || 1) - 1);
          if (ajustes.falloDiscoVeces === 0) { ajustes.falloDisco = ''; ajustes.falloDiscoVeces = 1; }
          throw new ErrorDisco({ name: nombre, message: 'fallo simulado' }, 'escribir');
        }
        return escribir(pos, datos);
      };
      // Cierre retrasado (y, si se pide, interrumpido): la ventana en la que un archivo ya escrito
      // todavía se está cerrando.
      const cerrarFlujo = u.flujo.close.bind(u.flujo);
      u.flujo.close = async () => {
        const lento = ajustes.cierreLento;
        if (!lento || lento.id !== a.id) return cerrarFlujo();
        const apunte = { id: a.id, inicio: Date.now(), fin: 0, resultado: '', abortado: 0 };
        cierres.push(apunte);
        u.apunteCierre = apunte;
        await new Promise((ok) => setTimeout(ok, lento.ms));
        try {
          if (lento.fallo) {
            await u.flujo.abort().catch(() => {});
            throw new DOMException('cierre interrumpido (simulado)', lento.fallo);
          }
          await cerrarFlujo();
          apunte.resultado = 'cerrado';
        } catch (e) {
          apunte.resultado = 'fallo';
          throw e;
        } finally {
          apunte.fin = Date.now();
        }
      };
      const abortar = u.abortar.bind(u);
      u.abortar = () => {
        if (u.apunteCierre && !u.apunteCierre.abortado) u.apunteCierre.abortado = Date.now();
        return abortar();
      };
      return u;
    };
  }
  return e;
}

let interfaz = null;
let faseVista = '';

const sesion = new Sesion({
  ubicacion: { pathname: location.pathname, hash: enMarco ? '' : location.hash },
  encuentro: ENCUENTRO,
  paginaLocal: esLocal,
  soportado: typeof window.showDirectoryPicker === 'function',
  elegirCarpeta,
  crearEscritor,
  // Relativa a este módulo: vale igual en /app/ (motor) que en la carpeta del sitio estático.
  urlTrabajador: new URL('./trabajador.js', import.meta.url).href,
  trabajadores: params.get('trabajadores') || undefined,
  sinDatosMs: prueba && Number(params.get('vigia')) >= 200 ? Number(params.get('vigia')) : undefined,
  simularPermiso: prueba && params.get('permiso') === 'pedir',
  // Solo en pruebas: vigías y esperas más cortos.
  discoUnidadMs: milis('disco-ms', 10),
  plazoTrabajoMs: milis('vigia-trabajador', 200),
  plazoEscrituraMs: milis('vigia-disco', 200),
  plazoListoMs: milis('vigia-listo', 200),
  alCambiar: () => { if (interfaz) interfaz.pintar(); },
  alAviso: (texto) => { if (interfaz) interfaz.avisar(texto); },
});

/* ---------- pantalla encendida mientras descarga y la pestaña está a la vista ---------- */
// El navegador solo deja pedir el bloqueo de suspensión con la pestaña a la vista, y lo retira en
// cuanto se oculta: se vuelve a pedir cada vez que vuelve a estar visible. Con la pestaña oculta o
// minimizada no hay bloqueo, y el equipo puede suspenderse si así lo tiene configurado.
let candado = null;
let pidiendo = false;
const pantalla = { pedidos: 0, retirados: 0 };
// También mientras se espera para reintentar sola una escritura («preparando»).
const quierePantalla = () => (sesion.fase === 'descargando' || sesion.fase === 'preparando') && document.visibilityState === 'visible';
async function cuidarPantalla() {
  const hace = quierePantalla();
  if (hace && !candado && !pidiendo && navigator.wakeLock) {
    pidiendo = true;
    try {
      pantalla.pedidos++;
      const c = await navigator.wakeLock.request('screen');
      candado = c;
      c.addEventListener('release', () => {
        pantalla.retirados++;
        if (candado !== c) return;
        candado = null;
        // Si lo ha retirado el sistema con la pestaña aún a la vista, se pide de nuevo al cabo de un momento.
        if (quierePantalla()) setTimeout(cuidarPantalla, 5000);
      });
    } catch { /* el sistema no lo permite ahora: no pasa nada */ }
    pidiendo = false;
    if (!quierePantalla()) cuidarPantalla();
  } else if (!hace && candado) {
    const c = candado;
    candado = null;
    c.release().catch(() => {});
  }
}
document.addEventListener('visibilitychange', () => {
  cuidarPantalla();
  if (document.visibilityState !== 'visible') return;
  sesion.alVolver();
  if (interfaz) interfaz.pintar();
});

/* ---------- aviso antes de cerrar con la descarga en marcha ---------- */
window.addEventListener('beforeunload', (ev) => {
  if (sesion.fase === 'descargando' || sesion.fase === 'preparando') {
    ev.preventDefault();
    ev.returnValue = '';
  }
});

// Al recuperar la conexión no se espera a que venza la cuenta atrás (y, en el modo fijo, se pregunta
// de nuevo dónde está el motor).
window.addEventListener('online', () => sesion.alConectar());

interfaz = crearInterfaz(sesion, {
  alPintar: () => {
    if (sesion.fase !== faseVista) {
      faseVista = sesion.fase;
      document.documentElement.dataset.fase = sesion.fase;
      cuidarPantalla();
    }
  },
});
interfaz.pintarYa();

if (prueba) {
  window.__lata = {
    estado: () => sesion.instantanea(),
    iniciar: () => sesion.elegirCarpeta(),
    pausar: () => sesion.pausar(),
    reanudar: () => sesion.reanudar(),
    reintentar: () => sesion.reintentarAhora(),
    ajustar: (cambios) => Object.assign(ajustes, cambios),
    // Cierra de golpe un trabajador que tenga un encargo, sin que avise: como si muriera en silencio.
    matarTrabajador: () => {
      const t = sesion.descarga && sesion.descarga.trabajadores.find((x) => x.trabajo !== null);
      if (t) t.w.terminate();
      return !!t;
    },
    pantalla: () => ({ ...pantalla, candado: !!candado }),
    carpetasPedidas: () => carpetasPedidas,
    cierres: () => cierres.map((c) => ({ ...c })),
    // Como si el navegador hubiera dejado de dar por concedido el permiso de la carpeta que la pestaña conserva.
    perderPermiso: () => { sesion.simularPermiso = true; },
  };
}

if (enMarco) {
  sesion.invalidar('marco');
} else {
  sesion.arrancar().catch((e) => {
    console.error('Lata: fallo al arrancar', e);
    sesion.invalidar('interno');
  });
}
