// Memoria entre visitas, en IndexedDB y por compartición (clave: shareId en texto).
//
//   comparticiones   { shareId, clientId, carpeta (FileSystemDirectoryHandle), seleccion, msActivo }
//   hechos           { clave: "<shareId>/<fileId>", version }   archivos que ESTE navegador completó y verificó
//
// Es SOLO una pista: lo que cuenta al reanudar es lo que hay de verdad en la carpeta. Todo se guarda
// en el momento (sin esperas), porque la pestaña puede cerrarse justo después.
// Si IndexedDB no está disponible, la página funciona igual pero sin recordar nada.
//
// Aquí nunca se guarda el secreto del enlace.

const BD = 'lata';
const COMPARTICIONES = 'comparticiones';
const HECHOS = 'hechos';

let bdPromesa = null;

function abrirBd() {
  if (!bdPromesa) {
    bdPromesa = new Promise((ok, mal) => {
      let pet;
      try { pet = indexedDB.open(BD, 1); } catch (e) { mal(e); return; }
      pet.onupgradeneeded = () => {
        pet.result.createObjectStore(COMPARTICIONES, { keyPath: 'shareId' });
        pet.result.createObjectStore(HECHOS, { keyPath: 'clave' });
      };
      pet.onsuccess = () => ok(pet.result);
      pet.onerror = () => mal(pet.error);
      pet.onblocked = () => mal(new Error('IndexedDB bloqueada'));
    });
    bdPromesa.catch(() => { bdPromesa = null; });
  }
  return bdPromesa;
}

function operar(almacen, modo, fn) {
  return abrirBd().then((bd) => new Promise((ok, mal) => {
    const tx = bd.transaction(almacen, modo);
    let resultado;
    const pet = fn(tx.objectStore(almacen));
    if (pet) pet.onsuccess = () => { resultado = pet.result; };
    tx.oncomplete = () => ok(resultado);
    tx.onerror = () => mal(tx.error);
    tx.onabort = () => mal(tx.error || new Error('transacción anulada'));
  }));
}

const rango = (shareId) => IDBKeyRange.bound(shareId + '/', shareId + '/￿');

export async function leer(shareId) {
  try {
    return (await operar(COMPARTICIONES, 'readonly', (s) => s.get(shareId))) || null;
  } catch {
    return null;
  }
}

// Sustituye el registro entero. Devuelve false si no se pudo guardar.
export async function guardar(registro) {
  try {
    await operar(COMPARTICIONES, 'readwrite', (s) => s.put(registro));
    return true;
  } catch {
    return false;
  }
}

// Map fileId → version de los archivos que este navegador completó.
export async function leerHechos(shareId) {
  const m = new Map();
  try {
    const filas = (await operar(HECHOS, 'readonly', (s) => s.getAll(rango(shareId)))) || [];
    for (const f of filas) m.set(Number(f.clave.slice(shareId.length + 1)), f.version);
  } catch { /* sin memoria: todo se tratará como «ya estaba» */ }
  return m;
}

export function marcarHecho(shareId, fileId, version) {
  return operar(HECHOS, 'readwrite', (s) => s.put({ clave: `${shareId}/${fileId}`, version })).catch(() => {});
}

export function olvidarHecho(shareId, fileId) {
  return operar(HECHOS, 'readwrite', (s) => s.delete(`${shareId}/${fileId}`)).catch(() => {});
}

export function olvidarHechos(shareId) {
  return operar(HECHOS, 'readwrite', (s) => s.delete(rango(shareId))).catch(() => {});
}

// Preferencias sueltas (la paleta de color), en localStorage.
export function leerPreferencia(clave) {
  try { return localStorage.getItem('lata-' + clave); } catch { return null; }
}
export function guardarPreferencia(clave, valor) {
  try { localStorage.setItem('lata-' + clave, valor); } catch { /* sin almacenamiento: no pasa nada */ }
}
