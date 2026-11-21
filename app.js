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
const ajustes = { falloDisco: '' };

// La página fija no puede enviar cabeceras propias, y `frame-ancestors` no vale en una etiqueta <meta>:
// si está dentro de un marco, no funciona (ni lee el enlace, ni pide nada). Vale también para la copia
// que sirve el motor, que además lo prohíbe con su cabecera.
const enMarco = (() => { try { return window.top !== window.self; } catch { return true; } })();

function elegirCarpeta() {
  if (prueba) {
    // En pruebas la carpeta sale del almacenamiento privado del navegador (OPFS), sin ventana de selección.
    const nombre = /^[a-z0-9-]{1,40}$/.test(params.get('carpeta') || '') ? params.get('carpeta') : 'prueba';
    return navigator.storage.getDirectory().then((raiz) => raiz.getDirectoryHandle('lata-' + nombre, { create: true }));
  }
  return window.showDirectoryPicker({ id: 'lata', mode: 'readwrite', startIn: 'downloads' });
}

function crearEscritor(carpeta, tamTrozo, shareIdTexto) {
  const e = new EscritorPartes(carpeta, tamTrozo, shareIdTexto);
  if (prueba) {
    // Permite simular un fallo de disco en la siguiente escritura (ajustar({ falloDisco: 'QuotaExceededError' })).
    const abrir = e.abrirUnidad.bind(e);
    e.abrirUnidad = async (a, k) => {
      const u = await abrir(a, k);
      const escribir = u.escribir.bind(u);
      u.escribir = async (pos, datos) => {
        if (ajustes.falloDisco) {
          const nombre = ajustes.falloDisco;
          ajustes.falloDisco = '';
          throw new ErrorDisco({ name: nombre, message: 'fallo simulado' }, 'escribir');
        }
        return escribir(pos, datos);
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
  alCambiar: () => { if (interfaz) interfaz.pintar(); },
  alAviso: (texto) => { if (interfaz) interfaz.avisar(texto); },
});

/* ---------- pantalla encendida mientras descarga y la pestaña está a la vista ---------- */
let candado = null;
let pidiendo = false;
async function cuidarPantalla() {
  const hace = sesion.fase === 'descargando' && document.visibilityState === 'visible';
  if (hace && !candado && !pidiendo && navigator.wakeLock) {
    pidiendo = true;
    try {
      candado = await navigator.wakeLock.request('screen');
      candado.addEventListener('release', () => { candado = null; });
    } catch { /* el sistema no lo permite ahora: no pasa nada */ }
    pidiendo = false;
    if (sesion.fase !== 'descargando') cuidarPantalla();
  } else if (!hace && candado) {
    const c = candado;
    candado = null;
    c.release().catch(() => {});
  }
}
document.addEventListener('visibilitychange', () => {
  cuidarPantalla();
  if (document.visibilityState === 'visible' && interfaz) interfaz.pintar();
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
