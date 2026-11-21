// Interfaz de la página receptora. Lee el estado de la sesión y lo pinta; no decide nada de la descarga.
// Sin HTML en línea con datos ajenos: los nombres de archivo entran siempre como texto.

import { guardarPreferencia, leerPreferencia } from './almacen.js';
import { duracion, num, plural, porcentaje, restante, tam, velocidad } from './formato.js';

const $ = (id) => document.getElementById(id);

const ICO = {
  ok: 'M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z',
  baja: 'M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z',
  cola: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16zm.5-13H11v6l5.2 3.2.8-1.3-4.5-2.7V7z',
  pausa: 'M6 19h4V5H6v14zm8-14v14h4V5h-4z',
  seguir: 'M8 5v14l11-7z',
  carpeta: 'M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z',
  alerta: 'M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z',
  menos: 'M19 13H5v-2h14v2z',
  guardar: 'M17 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7l-4-4zm-5 16a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm3-10H5V5h10v4z',
  cambio: 'M12 4V1L8 5l4 4V6a6 6 0 0 1 6 6c0 1-.25 1.97-.7 2.8l1.46 1.46A7.93 7.93 0 0 0 20 12a8 8 0 0 0-8-8zm0 14a6 6 0 0 1-6-6c0-1 .25-1.97.7-2.8L5.24 7.74A7.93 7.93 0 0 0 4 12a8 8 0 0 0 8 8v3l4-4-4-4v3z',
  copiar: 'M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z',
  red: 'M19.35 10.04A7.49 7.49 0 0 0 12 4a7.48 7.48 0 0 0-6.65 4.04A6 6 0 0 0 6 20h13a5 5 0 0 0 .35-9.96zM13 17h-2v-2h2v2zm0-4h-2V8h2v5z',
  cargando: 'M12 4V2a10 10 0 1 0 10 10h-2a8 8 0 1 1-8-8z',
  navegador: 'M20 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 14H4V8h16v10z',
  flecha: 'M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z',
  archivos: 'M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z',
};

const NS = 'http://www.w3.org/2000/svg';
function icono(nombre) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', ICO[nombre] || ICO.cola);
  svg.appendChild(p);
  return svg;
}

function el(etiqueta, attrs, ...hijos) {
  const e = document.createElement(etiqueta);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === false || v === null || v === undefined) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const h of hijos) if (h !== null && h !== undefined) e.append(h);
  return e;
}

const GB = 1073741824;
const MB = 1048576;
// «3,6 de 5,8 GB»: las dos cifras en la unidad del total.
function tamDe(hecho, total) {
  if (total >= GB) return `${num(hecho / GB, 1)} de ${tam(total)}`;
  if (total >= MB) return `${num(hecho / MB, total / MB >= 100 ? 0 : 1)} de ${tam(total)}`;
  if (total >= 1024) return `${num(Math.round(hecho / 1024))} de ${tam(total)}`;
  return `${num(hecho)} de ${tam(total)}`;
}

// Nombre de la opción en la ventana de permiso del navegador, en el idioma del navegador (Chrome y
// Edge la muestran en su idioma, no en el de la página).
function opcionPermiso() {
  const es = /^es\b/i.test(navigator.language || '');
  return { etiqueta: es ? 'Permitir en cada visita' : 'Allow on every visit', idioma: es ? 'es' : 'en' };
}
// La frase vale aunque el navegador use otras palabras: describe la opción y después cita su nombre.
function consejoPermiso() {
  const o = opcionPermiso();
  return {
    antes: 'El navegador te va a preguntar por la carpeta. Elige la opción de permitir en cada visita («',
    etiqueta: o.etiqueta, idioma: o.idioma,
    despues: '») para que no vuelva a preguntar durante la descarga.',
  };
}

const cuenta = (e) => (e ? Math.max(1, Math.ceil((e.hasta - Date.now()) / 1000)) : 0);

/* ------------------------------------------------------------------ qué enseñar en cada fase */

const TEXTO_INVALIDO = {
  formato: 'Al enlace le falta una parte. Cópialo entero, tal como te lo enviaron (incluido lo que va después de «#»), y ábrelo de nuevo.',
  revocado: 'Puede que quien te lo envió haya dejado de compartir, o que al enlace le falte un trozo. Pídele un enlace nuevo y ábrelo tal cual, completo.',
  manifiesto: 'La lista de archivos no se pudo leer con este enlace. Comprueba que lo has copiado entero o pide uno nuevo.',
  host: 'El equipo que comparte no admite esta dirección. Pide el enlace de nuevo a quien te lo envió.',
};

function textoEspera(e) {
  const n = cuenta(e);
  const en = `en ${n} s`;
  switch (e.motivo) {
    case 'paused':
      return { titulo: 'Quien comparte ha puesto la descarga en pausa', texto: `Continuará sola cuando la reanude; no hace falta que hagas nada. Se comprueba de nuevo ${en}.`, corto: 'En pausa en el origen' };
    case 'source_unavailable':
      return { titulo: 'El equipo que comparte no tiene acceso a su disco', texto: `No puede leer sus archivos ahora mismo (por ejemplo, tiene el disco desconectado). Avísale. La descarga continuará sola; se comprueba de nuevo ${en}.`, corto: 'El emisor no tiene acceso al disco' };
    case 'rate_limited':
      return { titulo: 'El equipo que comparte pide ir más despacio', texto: `Hay demasiadas peticiones seguidas. Se continúa sola ${en}.`, corto: 'Esperando turno' };
    case 'protocolo':
      return { titulo: 'El equipo que comparte ha respondido algo inesperado', texto: 'Puede que su programa y esta página sean de versiones distintas. Se reintenta ' + en + '; si sigue igual, avisa a quien te envió el enlace.', corto: 'Respuesta inesperada' };
    case 'antiguo':
      return { titulo: 'El emisor envió una lista más antigua que la que ya tenías', texto: `No se va a usar: se vuelve a pedir ${en}. La descarga continuará con la lista correcta; si sigue igual, avisa a quien te envió el enlace.`, corto: 'Reintentando' };
    // Modo fijo: todavía no se sabe dónde está el equipo que comparte.
    case 'sin-puntero':
      return { titulo: 'Esperando a quien comparte', texto: `Su equipo todavía no ha dicho dónde está: puede estar apagado o arrancando. No hace falta que hagas nada: se comprueba de nuevo ${en}. Si lleva mucho así, comprueba que copiaste el enlace entero.`, corto: 'Esperando a quien comparte' };
    case 'encuentro':
      return { titulo: 'Esperando a quien comparte', texto: `Ahora mismo no se puede preguntar dónde está su equipo (puede que no tengas conexión, o que el servicio que lo indica no responda). No hace falta que hagas nada: se reintenta ${en}.`, corto: 'Esperando a quien comparte' };
    case 'puntero-antiguo':
      return { titulo: 'Esperando a quien comparte', texto: `Ha llegado una dirección de su equipo más antigua que la que ya conocías. No se va a usar: se vuelve a preguntar ${en}. Si sigue igual, avisa a quien te envió el enlace.`, corto: 'Esperando a quien comparte' };
    case 'puntero-no-vale':
      return { titulo: 'Esperando a quien comparte', texto: `La dirección de su equipo que ha llegado no se puede usar con este enlace. Se vuelve a preguntar ${en}. Si sigue igual, comprueba que copiaste el enlace entero o avisa a quien te lo envió.`, corto: 'Esperando a quien comparte' };
    case 'datos':
      return { titulo: 'Han llegado datos dañados', texto: `Se han descartado y se vuelven a pedir ${en}. Nada dañado se guarda en tu carpeta.`, corto: 'Repitiendo datos dañados' };
    default:
      return { titulo: 'Sin conexión con el equipo que comparte', texto: `Puede estar apagado, suspendido o sin internet. No hace falta que hagas nada: se reintenta ${en} y la descarga sigue donde iba.`, corto: 'Reconectando' };
  }
}

function textoDisco(err, s, falta) {
  const carpeta = s.nombreCarpeta ? `«${s.nombreCarpeta}»` : 'elegida';
  switch (err.causa) {
    case 'QuotaExceededError':
      return { titulo: 'El disco está lleno', texto: `Libera espacio en el disco de la carpeta ${carpeta} (quedan por guardar ${tam(falta)}) y pulsa «Reintentar». Lo ya descargado no se pierde.` };
    case 'NotAllowedError':
    case 'SecurityError':
      return { titulo: 'El navegador ya no tiene permiso para escribir en la carpeta', texto: 'Pulsa «Reintentar» y acepta el permiso cuando el navegador lo pida. Lo ya descargado no se pierde.' };
    case 'NotFoundError':
      return { titulo: 'No se encuentra la carpeta', texto: `Puede que el disco se haya desconectado o que la carpeta ${carpeta} se haya movido o borrado. Vuelve a conectarlo y pulsa «Reintentar», o elige otra carpeta.` };
    case 'NoModificationAllowedError':
    case 'InvalidStateError':
    case 'InvalidModificationError':
      return { titulo: 'No se pudo escribir en la carpeta', texto: 'Otro programa puede estar usando los archivos (un antivirus, una copia de seguridad o la sincronización con la nube). Espera un momento y pulsa «Reintentar». Si se repite, elige una carpeta que no se sincronice con la nube.' };
    default:
      return { titulo: 'No se pudo escribir en la carpeta', texto: `Comprueba que hay espacio libre (quedan por guardar ${tam(falta)}) y que la carpeta ${carpeta} sigue disponible, y pulsa «Reintentar». Lo ya descargado no se pierde.` };
  }
}

function vista(s) {
  const m = s.manifiesto;
  const t = s.totales();
  const nombre = m ? (m.nombre || 'Archivos compartidos') : '';
  const pct = porcentaje(t.bytesVisual, t.bytesTotal);
  const parcial = m && t.elegidos < t.validos;
  const v = {
    sobre: 'Te han compartido', titulo: nombre, anillo: null, mensaje: null, avance: null, acciones: [], lista: false, consejo: null, nota: '', colisiones: null,
    sub: m ? `${plural(t.total, 'archivo', 'archivos')} · ${tam(t.bytesTodo)}` + (parcial ? ` · elegidos ${num(t.elegidos)} (${tam(t.bytesTotal)})` : '') : '',
    pie: '', anuncio: '', tituloPagina: nombre ? `${nombre} — Lata` : 'Lata',
  };
  const cifras = `${tam(t.bytesVisual)} de ${tam(t.bytesTotal)}`;
  const elegir = { id: 'elegir-archivos', texto: 'Elegir archivos', tipo: 'tonal' };
  const e = s.espera;

  switch (s.fase) {
    case 'cargando': {
      v.sobre = 'Lata';
      v.titulo = 'Abriendo el enlace…';
      if (e) {
        const te = textoEspera(e);
        v.mensaje = { tono: 'espera', ico: e.motivo === 'red' ? 'red' : 'cola', titulo: te.titulo, texto: te.texto };
        v.acciones = [{ id: 'reintentar', texto: 'Reintentar ahora', tipo: 'lleno', ico: 'cambio' }];
        v.anuncio = te.titulo;
      } else {
        v.mensaje = { tono: 'cargando', ico: 'cargando', titulo: 'Cargando la lista de archivos…', texto: 'Se está comprobando el enlace. Es solo un momento.' };
      }
      break;
    }
    case 'invalido':
      v.sobre = 'Lata';
      v.titulo = 'Enlace no válido';
      v.mensaje = { tono: 'peligro', ico: 'alerta', titulo: 'Este enlace no es válido o ya no está activo', texto: TEXTO_INVALIDO[s.motivoInvalido] || TEXTO_INVALIDO.revocado };
      if (s.motivoInvalido === 'interno') {
        v.titulo = 'No se pudo abrir';
        v.mensaje.titulo = 'Algo ha fallado al abrir la página';
        v.mensaje.texto = 'Vuelve a cargarla. Si se repite, comprueba que usas una versión reciente de Chrome o Edge.';
      }
      v.acciones = [{ id: 'recargar', texto: 'Volver a intentar', tipo: 'tonal', ico: 'cambio' }];
      if (s.motivoInvalido === 'marco') {
        // La página está incrustada en otra: no hace nada, ni siquiera lee el enlace.
        v.titulo = 'No se puede abrir aquí';
        v.mensaje.titulo = 'Esta página está dentro de otra';
        v.mensaje.texto = 'Por seguridad, Lata no funciona incrustada en otra página. Abre el enlace directamente en una pestaña de Chrome o Edge.';
        v.acciones = [];
      }
      v.anuncio = v.mensaje.titulo;
      v.tituloPagina = v.titulo + ' — Lata';
      break;
    case 'incompatible':
      v.sobre = 'Lata';
      v.titulo = 'Hace falta Chrome o Edge';
      v.mensaje = {
        tono: 'espera', ico: 'navegador', titulo: 'Este navegador no puede guardar carpetas enteras',
        texto: 'Para descargar todo de una vez y que la descarga continúe sola si se corta, abre este mismo enlace en Chrome o Edge en un ordenador (Windows, Mac o Linux). En Firefox, en Safari y en móviles todavía no funciona.',
      };
      v.acciones = [{ id: 'copiar-enlace', texto: 'Copiar el enlace', tipo: 'lleno', ico: 'copiar' }];
      v.anuncio = v.mensaje.titulo;
      break;
    case 'otra-pestana':
      v.sobre = 'Lata';
      v.titulo = 'Ya está abierta';
      v.mensaje = { tono: 'espera', ico: 'navegador', titulo: 'Esta descarga ya está abierta en otra pestaña', texto: 'Sigue en aquella pestaña. Si la has cerrado, pulsa «Reintentar».' };
      v.acciones = [{ id: 'recargar', texto: 'Reintentar', tipo: 'lleno', ico: 'cambio' }];
      v.anuncio = v.mensaje.titulo;
      break;
    case 'listo':
      v.anillo = 0;
      v.lista = true;
      v.avance = {
        cifras: `${tam(t.bytesTotal)} en ${plural(t.elegidos, 'archivo', 'archivos')}`, pct: 0, punto: '',
        detalle: `Elige una carpeta nueva en un disco con al menos ${tam(t.bytesTotal)} libres. Los archivos se descargan solos y, si la conexión se corta o cierras la pestaña, la descarga continúa donde iba.`,
      };
      if (s.pideCarpeta) v.avance.detalle = 'Para descargar lo que has añadido, elige otra vez la carpeta (la misma, para aprovechar lo que ya está). Al terminar, la página deja de tener acceso a ella.';
      else if (s.completadaAntes) v.avance.detalle = 'Este navegador recuerda que ya terminaste esta descarga. Si quieres comprobarla o volver a bajar algo, elige la misma carpeta: lo que ya esté no se descarga otra vez.';
      v.acciones = [{ id: 'elegir-carpeta', texto: 'Elegir carpeta y descargar', tipo: 'lleno', ico: 'carpeta', desactivado: t.elegidos === 0 }, elegir];
      v.nota = 'El navegador te pedirá permiso para guardar en la carpeta que elijas: acéptalo. Mejor una carpeta nueva y vacía, y recuerda dónde está: después la página solo puede enseñarte su nombre, no la ruta completa.';
      v.pie = 'No hay que instalar nada: los archivos se descifran en tu navegador y se guardan en la carpeta que elijas.';
      break;
    case 'permiso':
      v.anillo = pct;
      v.lista = true;
      v.avance = {
        cifras: `${tam(t.bytesTotal)} en ${plural(t.elegidos, 'archivo', 'archivos')}`, pct, punto: 'espera',
        detalle: `Para seguir guardando en la carpeta «${s.nombreCarpeta}», el navegador necesita que confirmes el permiso otra vez. La descarga continúa donde iba.`
          + (t.recordados ? ` El avance que ves es lo que recuerda este navegador (${plural(t.recordados, 'archivo', 'archivos')}); se comprueba en la carpeta al continuar.` : ''),
      };
      v.consejo = consejoPermiso();
      v.acciones = [{ id: 'permiso', texto: 'Continuar la descarga', tipo: 'lleno', ico: 'seguir', descrito: true }, { id: 'elegir-carpeta', texto: 'Usar otra carpeta', tipo: 'texto' }];
      v.anuncio = 'Hace falta confirmar el permiso de la carpeta para continuar. Cuando el navegador pregunte, elige la opción de permitir en cada visita.';
      break;
    case 'colision': {
      const c = s.colision || { archivos: [], subcarpeta: '' };
      const n = c.archivos.length;
      v.mensaje = {
        tono: 'decision', ico: 'carpeta',
        titulo: n === 1 ? 'En esta carpeta ya hay un archivo con el mismo nombre' : 'En esta carpeta ya hay archivos con los mismos nombres',
        texto: (n === 1
          ? `Un archivo de la carpeta «${s.nombreCarpeta}» se llama igual que uno de los que vas a descargar, pero no es el mismo (tiene otro tamaño).`
          : `${num(n)} archivos de la carpeta «${s.nombreCarpeta}» se llaman igual que los que vas a descargar, pero no son los mismos (tienen otro tamaño).`)
          + ' No se ha tocado nada. ¿Dónde guardamos la descarga?',
      };
      v.colisiones = c.archivos;
      v.acciones = [
        { id: 'colision-subcarpeta', texto: `Guardar en una subcarpeta nueva «${c.subcarpeta}»`, tipo: 'lleno largo', ico: 'carpeta' },
        { id: 'colision-reemplazar', texto: n === 1 ? 'Reemplazar este archivo' : 'Reemplazar estos archivos', tipo: 'texto' },
        { id: 'elegir-carpeta', texto: 'Elegir otra carpeta', tipo: 'texto' },
      ];
      v.nota = 'En la subcarpeta nueva no se toca nada de lo que ya tienes. Si eliges reemplazar, se '
        + (n === 1 ? 'borra solo ese archivo y se descarga el nuevo en su sitio' : `borran solo esos ${num(n)} archivos y se descargan los nuevos en su sitio`)
        + '; el resto de la carpeta no se toca.';
      v.anuncio = v.mensaje.titulo + '. Hay que elegir dónde guardar la descarga.';
      v.tituloPagina = `Necesita tu decisión · ${nombre} — Lata`;
      break;
    }
    case 'preparando':
      v.anillo = pct;
      v.lista = true;
      v.avance = { cifras, pct, punto: 'vivo', detalle: 'Revisando lo que ya hay en la carpeta…' };
      if (e) {
        const te = textoEspera(e);
        v.avance = { cifras, pct, punto: 'espera', detalle: `${te.titulo}. ${te.texto}` };
        v.anuncio = te.titulo;
      }
      break;
    case 'descargando': {
      v.anillo = pct;
      v.lista = true;
      v.pie = 'Puedes cerrar esta pestaña. Al volver a abrir el enlace, sigue donde iba.';
      if (e) {
        const te = textoEspera(e);
        v.avance = { cifras, pct, punto: 'espera', detalle: `${te.titulo}. ${te.texto}` };
        v.acciones = [{ id: 'reintentar', texto: 'Reintentar ahora', tipo: 'lleno', ico: 'cambio' }, { id: 'pausar', texto: 'Pausar', tipo: 'texto' }];
        v.anuncio = te.titulo;
        v.tituloPagina = `${te.corto} · ${pct} % · ${nombre} — Lata`;
      } else {
        const partes = [];
        const d = s.descarga;
        if (s.velocidad > 0) {
          partes.push(velocidad(s.velocidad));
          const r = restante((t.bytesTotal - t.bytesVisual) / s.velocidad);
          if (r) partes.push(r);
        } else if (d && d.ensamblando && !d.trabajos.size) partes.push('Guardando en disco…');
        else if (s.terminando) partes.push('Últimas comprobaciones…');
        else partes.push('Conectando…');
        partes.push(t.verificados === 1 ? '1 archivo verificado' : `${num(t.verificados)} archivos verificados`);
        v.avance = { cifras, pct, punto: 'vivo', detalle: partes.join(' · ') };
        v.acciones = [{ id: 'pausar', texto: 'Pausar', tipo: 'lleno', ico: 'pausa' }, elegir];
        v.anuncio = 'Descargando.';
        v.tituloPagina = `${pct} % · ${nombre} — Lata`;
      }
      break;
    }
    case 'pausado':
      v.anillo = pct;
      v.lista = true;
      v.avance = { cifras, pct, punto: 'pausa', detalle: 'En pausa. Lo descargado está guardado. Pulsa «Reanudar» para continuar donde iba.' };
      v.acciones = [{ id: 'reanudar', texto: 'Reanudar', tipo: 'lleno', ico: 'seguir' }, elegir];
      v.anuncio = 'Descarga en pausa.';
      v.tituloPagina = `En pausa · ${pct} % · ${nombre} — Lata`;
      break;
    case 'disco': {
      const td = textoDisco(s.errorDisco || {}, s, Math.max(0, t.bytesTotal - t.bytesGuardados));
      v.anillo = pct;
      v.lista = true;
      v.mensaje = { tono: 'peligro', ico: 'alerta', titulo: td.titulo, texto: td.texto };
      v.avance = { cifras, pct, punto: 'error', detalle: 'La descarga está detenida hasta que se pueda escribir en la carpeta.' };
      // Si lo que falta es el permiso, al reintentar el navegador vuelve a preguntar: misma indicación.
      const sinPermiso = s.errorDisco && (s.errorDisco.causa === 'NotAllowedError' || s.errorDisco.causa === 'SecurityError');
      if (sinPermiso) v.consejo = consejoPermiso();
      v.acciones = [{ id: 'reintentar-disco', texto: 'Reintentar', tipo: 'lleno', ico: 'cambio', descrito: sinPermiso }, { id: 'elegir-carpeta', texto: 'Elegir otra carpeta', tipo: 'tonal' }];
      v.anuncio = td.titulo;
      v.tituloPagina = `Necesita atención · ${nombre} — Lata`;
      break;
    }
    case 'completado': {
      const r = s.resumen || { archivos: t.hechos, bytes: t.bytesGuardados, ms: 0, verificados: t.verificados, yaEstaban: t.yaEstaban, errores: t.errores, parcial };
      v.sobre = 'Descarga completa';
      v.anillo = 100;
      v.lista = true;
      const frases = [];
      if (r.yaEstaban === 0 && r.verificados > 0) {
        frases.push(r.verificados === 1 ? 'Verificado: cada bloque se autenticó al descifrarlo y el tamaño del archivo coincide.' : 'Todo verificado: cada bloque se autenticó al descifrarlo y el tamaño de cada archivo coincide.');
      } else {
        if (r.verificados > 0) frases.push(`${plural(r.verificados, 'archivo verificado', 'archivos verificados')} al descargar (bloques autenticados y tamaño correcto).`);
        if (r.yaEstaban > 0) frases.push(`${r.yaEstaban === 1 ? '1 archivo ya estaba' : num(r.yaEstaban) + ' archivos ya estaban'} en la carpeta con el tamaño correcto y no se ${r.yaEstaban === 1 ? 'ha' : 'han'} vuelto a comprobar.`);
      }
      if (r.errores > 0) frases.push(`${r.errores === 1 ? '1 archivo no se pudo' : num(r.errores) + ' archivos no se pudieron'} guardar: están marcados en la lista.`);
      if (s.restos > 0) frases.push('Quedan partes a medias de archivos que no elegiste (en «.lata-partes»): se aprovechan si los eliges más adelante; si no, puedes borrar esa carpeta.');
      v.avance = {
        cifras: `${plural(r.archivos, 'archivo', 'archivos')} · ${tam(r.bytes)}` + (r.ms >= 1000 ? ` · ${duracion(r.ms)}` : ''),
        pct: 100, punto: r.errores ? 'error' : 'ok', detalle: frases.join(' '),
      };
      if (r.parcial) v.acciones.push({ id: 'elegir-archivos', texto: 'Elegir más archivos', tipo: 'tonal' });
      v.pie = `Ya puedes cerrar esta pestaña. Los archivos están en la carpeta «${s.nombreCarpeta}»` + (s.destino ? `, dentro de «${s.destino}»` : '') + '. La página ya no tiene acceso a ella.';
      v.anuncio = 'Descarga completa.';
      v.tituloPagina = `Completado · ${nombre} — Lata`;
      break;
    }
    default:
  }
  return v;
}

// Estado de una fila: palabra de estado arriba y tamaño o avance debajo (a la derecha de la fila).
function estadoFila(a, s) {
  const visual = Math.min(a.tam, a.guardados + a.bytesAbiertos + a.bytesVuelo);
  const pct = porcentaje(visual, a.tam);
  if (a.error) return { clase: 'fallo', ico: 'alerta', l1: 'Error', l2: a.errorCorto || 'No se pudo guardar', nota: a.error };
  if (a.estado === 'hecho') {
    if (a.verificado) return { clase: 'hecho', ico: 'ok', l1: 'Verificado', l2: tam(a.tam) };
    return { clase: 'hecho', ico: 'ok', l1: 'Ya estaba', l2: tam(a.tam), nota: 'Ya estaba en la carpeta con el tamaño correcto; no se ha vuelto a comprobar' };
  }
  if (!a.elegido) return { clase: 'fuera', ico: 'menos', l1: 'No elegido', l2: tam(a.tam) };
  // Recordado por este navegador, pero todavía sin mirar la carpeta: estado neutro, nunca «Verificado».
  if (a.recordado) return { clase: 'cola', ico: 'cola', l1: 'Por comprobar', l2: tam(a.tam), nota: 'Este navegador recuerda haberlo descargado; se comprueba en la carpeta al continuar' };
  if (a.estado === 'ensamblando') return { clase: 'bajando', ico: 'guardar', l1: 'Guardando', l2: tam(a.tam), barra: Math.round((a.pctEnsamblado || 0) * 100) };
  const pausado = s.fase === 'pausado';
  if (s.fase === 'descargando' && a.activas.size > 0) {
    const e = s.espera;
    if (e) return { clase: 'atento', ico: e.motivo === 'red' ? 'red' : 'cola', l1: e.motivo === 'red' ? 'Reconectando' : 'Esperando', l2: tamDe(visual, a.tam), barra: pct };
    return { clase: 'bajando', ico: 'baja', l1: pct + ' %', l2: tamDe(visual, a.tam), barra: pct };
  }
  if (a.cambiado && visual === 0) return { clase: 'atento', ico: 'cambio', l1: 'Cambió', l2: tam(a.tam), nota: 'Cambió en el origen: se descarga de nuevo' };
  if (visual > 0) return { clase: 'cola', ico: pausado ? 'pausa' : 'cola', l1: pausado ? 'En pausa' : 'En cola', l2: tamDe(visual, a.tam), barra: pct };
  return { clase: 'cola', ico: pausado ? 'pausa' : 'cola', l1: pausado ? 'En pausa' : 'En cola', l2: tam(a.tam) };
}

/* ------------------------------------------------------------------ interfaz */

export function crearInterfaz(sesion, extras = {}) {
  const s = sesion;
  const acciones = {};
  let pendiente = false;
  let firmaAcciones = '';
  let ultimoAnuncio = '';
  let firmaConsejo = '';
  let firmaColisiones = '';

  /* ---------- avisos ---------- */
  let tAviso = 0;
  function avisar(texto) {
    const a = $('aviso-flotante');
    a.textContent = texto;
    a.hidden = false;
    clearTimeout(tAviso);
    tAviso = setTimeout(() => { a.hidden = true; }, 6000);
  }
  function dialogo(titulo, texto) {
    $('dlg-aviso-titulo').textContent = titulo;
    $('dlg-aviso-texto').textContent = texto;
    const d = $('dlg-aviso');
    if (!d.open) d.showModal();
  }
  $('dlg-aviso-cerrar').addEventListener('click', () => $('dlg-aviso').close());

  /* ---------- colores ---------- */
  const PALETAS = ['plata', 'ambar', 'telon', 'teal', 'sepia'];
  function ponerPaleta(p, recordar) {
    if (!PALETAS.includes(p)) p = 'plata';
    document.documentElement.dataset.paleta = p;
    for (const b of document.querySelectorAll('.muestra')) {
      const esta = b.dataset.pal === p;
      b.setAttribute('aria-checked', esta ? 'true' : 'false');
      b.tabIndex = esta ? 0 : -1;
    }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#0C0C0D');
    if (recordar) guardarPreferencia('paleta', p);
  }
  ponerPaleta(leerPreferencia('paleta') || 'plata', false);
  const temaBoton = $('tema-boton');
  const temaMenu = $('tema-menu');
  function abrirTema(abrir) {
    temaMenu.hidden = !abrir;
    temaBoton.setAttribute('aria-expanded', abrir ? 'true' : 'false');
    if (abrir) (temaMenu.querySelector('[aria-checked="true"]') || temaMenu.firstElementChild).focus();
  }
  temaBoton.addEventListener('click', () => abrirTema(temaMenu.hidden));
  temaMenu.addEventListener('click', (ev) => {
    const b = ev.target.closest('.muestra');
    if (b) ponerPaleta(b.dataset.pal, true);
  });
  temaMenu.addEventListener('keydown', (ev) => {
    const lista = [...temaMenu.querySelectorAll('.muestra')];
    const i = lista.indexOf(document.activeElement);
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown' || ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      const d = ev.key === 'ArrowRight' || ev.key === 'ArrowDown' ? 1 : -1;
      const b = lista[(i + d + lista.length) % lista.length];
      ponerPaleta(b.dataset.pal, true);
      b.focus();
    } else if (ev.key === 'Escape') {
      abrirTema(false);
      temaBoton.focus();
    }
  });
  document.addEventListener('click', (ev) => {
    if (!temaMenu.hidden && !ev.target.closest('.tema')) abrirTema(false);
  });

  /* ---------- acciones de la tarjeta ---------- */
  $('acciones').addEventListener('click', async (ev) => {
    const b = ev.target.closest('button[data-accion]');
    if (!b || b.disabled) return;
    const fn = acciones[b.dataset.accion];
    if (!fn) return;
    b.disabled = true;
    try { await fn(); } finally { b.disabled = b.dataset.desactivado === '1'; pintar(); }
  });
  acciones['elegir-carpeta'] = () => s.elegirCarpeta();
  acciones.permiso = () => s.concederPermiso();
  acciones.pausar = () => s.pausar();
  acciones.reanudar = () => s.reanudar();
  acciones.reintentar = () => s.reintentarAhora();
  acciones['reintentar-disco'] = () => s.reintentarDisco();
  acciones['colision-subcarpeta'] = () => s.resolverColision('subcarpeta');
  acciones['colision-reemplazar'] = () => s.resolverColision('reemplazar');
  acciones.recargar = () => location.reload();
  acciones['elegir-archivos'] = () => abrirSeleccion();
  acciones['copiar-enlace'] = async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      avisar('Enlace copiado. Pégalo en Chrome o Edge.');
    } catch {
      dialogo('Copia el enlace a mano', 'Selecciona la dirección de esta página en la barra del navegador, cópiala entera y pégala en Chrome o Edge.');
    }
  };

  /* ---------- tarjeta ---------- */
  function pintarTarjeta(v) {
    $('sobre').textContent = v.sobre;
    $('titulo').textContent = v.titulo;
    $('sub').textContent = v.sub;
    if (document.title !== v.tituloPagina) document.title = v.tituloPagina;

    const anillo = $('anillo');
    anillo.hidden = v.anillo === null;
    if (v.anillo !== null) {
      anillo.style.setProperty('--p', String(v.anillo));
      $('anillo-num').textContent = String(v.anillo);
    }

    const m = $('mensaje');
    m.hidden = !v.mensaje;
    if (v.mensaje) {
      m.className = 'mensaje ' + v.mensaje.tono;
      const ico = $('mensaje-ico');
      if (ico.dataset.ico !== v.mensaje.ico) { ico.dataset.ico = v.mensaje.ico; ico.replaceChildren(icono(v.mensaje.ico)); }
      $('mensaje-titulo').textContent = v.mensaje.titulo;
      $('mensaje-texto').textContent = v.mensaje.texto;
    }

    const av = $('avance');
    av.hidden = !v.avance;
    if (v.avance) {
      $('cifras').textContent = v.avance.cifras;
      $('pista-relleno').style.width = v.avance.pct + '%';
      $('pista').setAttribute('aria-valuenow', String(v.avance.pct));
      const punto = $('detalle-punto');
      punto.hidden = !v.avance.punto;
      punto.className = 'punto ' + (v.avance.punto || '');
      $('detalle-texto').textContent = v.avance.detalle;
    }

    // Archivos que chocan con lo que ya hay en la carpeta (como mucho ocho a la vista).
    const lc = $('colisiones');
    lc.hidden = !v.colisiones;
    const fcol = v.colisiones ? v.colisiones.map((c) => `${c.id}:${c.aqui}`).join(',') : '';
    if (fcol !== firmaColisiones) {
      firmaColisiones = fcol;
      const filas = (v.colisiones || []).slice(0, 8).map((c) => el('li', null,
        el('span', { class: 'ruta', text: c.ruta }),
        el('span', { class: 'tams', text: tam(c.aqui) === tam(c.llega) ? `aquí ${plural(c.aqui, 'byte', 'bytes')} · llega ${plural(c.llega, 'byte', 'bytes')}` : `aquí ${tam(c.aqui)} · llega ${tam(c.llega)}` })));
      if (v.colisiones && v.colisiones.length > 8) filas.push(el('li', { class: 'mas', text: `y ${num(v.colisiones.length - 8)} más` }));
      lc.replaceChildren(...filas);
    }

    // Indicación sobre la ventana de permiso, justo encima del botón.
    const consejo = $('consejo');
    consejo.hidden = !v.consejo;
    const fc = v.consejo ? v.consejo.etiqueta : '';
    if (fc !== firmaConsejo) {
      firmaConsejo = fc;
      if (v.consejo) {
        $('consejo-texto').replaceChildren(v.consejo.antes, el('strong', { lang: v.consejo.idioma, text: v.consejo.etiqueta }), v.consejo.despues);
      } else $('consejo-texto').replaceChildren();
    }
    const nota = $('nota-acciones');
    nota.hidden = !v.nota;
    if (nota.textContent !== v.nota) nota.textContent = v.nota;

    // Los botones solo se rehacen si cambian, para no perder el foco del teclado en cada repintado.
    const firma = v.acciones.map((a) => `${a.id}|${a.texto}|${a.tipo}|${a.desactivado ? 1 : 0}|${a.descrito ? 1 : 0}`).join('¬');
    if (firma !== firmaAcciones) {
      const caja = $('acciones');
      const foco = document.activeElement && caja.contains(document.activeElement) ? document.activeElement.dataset.accion : '';
      firmaAcciones = firma;
      caja.replaceChildren(...v.acciones.map((a) => {
        const b = el('button', { type: 'button', class: 'btn ' + a.tipo, 'data-accion': a.id, 'data-desactivado': a.desactivado ? '1' : '0' }, a.ico ? icono(a.ico) : null, a.texto);
        b.disabled = !!a.desactivado;
        if (a.descrito) b.setAttribute('aria-describedby', 'consejo-texto');
        return b;
      }));
      // Si el botón con foco desaparece, el foco pasa a la acción principal del nuevo estado.
      if (foco) {
        const b = caja.querySelector(`[data-accion="${foco}"]`) || caja.querySelector('button');
        if (b) b.focus();
      }
    }

    $('pie').textContent = v.pie;
    if (v.anuncio !== ultimoAnuncio) {
      ultimoAnuncio = v.anuncio;
      $('anuncio').textContent = v.anuncio;
    }
    $('zona-lista').hidden = !v.lista;
  }

  /* ---------- lista ---------- */
  const lista = { q: '', orden: 'nombre', ocultar: false, limite: 200, filas: [], firma: '' };
  const colator = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });

  function visibles() {
    const q = lista.q;
    let v = s.archivos.filter((a) => (!q || a.ruta.toLowerCase().includes(q)) && !(lista.ocultar && a.estado === 'hecho'));
    // s.archivos ya está ordenado por nombre y la ordenación es estable: a igual tamaño, queda por nombre.
    if (lista.orden === 'mayor') v = v.slice().sort((x, y) => y.tam - x.tam);
    else if (lista.orden === 'menor') v = v.slice().sort((x, y) => x.tam - y.tam);
    return v;
  }

  function crearFila(a, n) {
    const corte = a.ruta.lastIndexOf('/') + 1;
    const nom = el('div', { class: 'nom', title: a.ruta },
      corte ? el('span', { class: 'dir', text: a.ruta.slice(0, corte - 1) }) : null, corte ? el('span', { class: 'barra', text: '/' }) : null,
      el('span', { class: 'arch', text: a.ruta.slice(corte) }));
    const relleno = el('i');
    const mini = el('div', { class: 'pista mini', hidden: true }, relleno);
    const est = el('span', { class: 'est' });
    const b = el('b');
    const span = el('span');
    const li = el('li', null, est, el('div', null, nom, mini), el('div', { class: 'lado' }, b, span));
    if (n < 12) { li.classList.add('entra'); li.style.setProperty('--i', String(n)); }
    return { a, li, est, nom, mini, relleno, b, span, firma: '', ico: '', entra: n < 12 };
  }

  function actualizarFila(f) {
    const e = estadoFila(f.a, s);
    const firma = `${e.clase}|${e.ico}|${e.l1}|${e.l2}|${e.barra === undefined ? -1 : e.barra}`;
    if (firma === f.firma) return;
    f.firma = firma;
    f.li.className = e.clase + (f.entra ? ' entra' : '');
    if (f.ico !== e.ico) { f.ico = e.ico; f.est.replaceChildren(icono(e.ico)); }
    f.b.textContent = e.l1;
    f.span.textContent = e.l2;
    f.nom.title = e.nota ? `${f.a.ruta} — ${e.nota}` : f.a.ruta;
    f.mini.hidden = e.barra === undefined;
    if (e.barra !== undefined) f.relleno.style.width = e.barra + '%';
  }

  function pintarLista() {
    const nHechos = lista.ocultar ? s.archivos.reduce((n, a) => n + (a.estado === 'hecho' ? 1 : 0), 0) : 0;
    const firma = [s.versionPlan, s.archivos.length, lista.q, lista.orden, lista.ocultar, lista.limite, nHechos].join('|');
    if (firma !== lista.firma) {
      const primera = lista.firma === '';
      lista.firma = firma;
      const v = visibles();
      const ul = $('lista');
      lista.filas = v.slice(0, lista.limite).map((a, n) => crearFila(a, primera ? n : 99));
      if (lista.filas.length) ul.replaceChildren(...lista.filas.map((f) => f.li));
      else {
        const texto = lista.q ? `Ningún archivo coincide con «${lista.q}».`
          : (lista.ocultar && s.archivos.length ? 'Todos los archivos están completados.' : 'Esta carpeta compartida está vacía.');
        ul.replaceChildren(el('li', { class: 'vacio', text: texto }));
      }
      const mas = $('mas');
      mas.hidden = v.length <= lista.limite;
      if (!mas.hidden) mas.textContent = `Mostrar más (quedan ${num(v.length - lista.limite)})`;
      $('herramientas').hidden = s.archivos.length < 2;
    }
    for (const f of lista.filas) actualizarFila(f);
  }

  $('buscar').addEventListener('input', () => { lista.q = $('buscar').value.trim().toLowerCase(); lista.limite = 200; pintarLista(); });
  for (const b of document.querySelectorAll('.filtro[data-orden]')) {
    b.addEventListener('click', () => {
      lista.orden = b.dataset.orden;
      for (const c of document.querySelectorAll('.filtro[data-orden]')) c.setAttribute('aria-pressed', c === b ? 'true' : 'false');
      pintarLista();
    });
  }
  $('ocultar').addEventListener('click', () => {
    lista.ocultar = !lista.ocultar;
    $('ocultar').setAttribute('aria-pressed', lista.ocultar ? 'true' : 'false');
    pintarLista();
  });
  $('mas').addEventListener('click', () => { lista.limite += 500; pintarLista(); });

  /* ---------- elegir archivos ---------- */
  const sel = { ids: new Set(), raiz: null, controles: [], q: '' };

  function construirArbol() {
    const raiz = { nombre: '', carpetas: new Map(), archivos: [], todos: [], tam: 0, abierta: true };
    for (const a of s.archivos) {
      const partes = a.ruta.split('/');
      let nodo = raiz;
      const cadena = [raiz];
      for (let i = 0; i < partes.length - 1; i++) {
        let h = nodo.carpetas.get(partes[i]);
        if (!h) { h = { nombre: partes[i], carpetas: new Map(), archivos: [], todos: [], tam: 0, abierta: false }; nodo.carpetas.set(partes[i], h); }
        nodo = h;
        cadena.push(h);
      }
      nodo.archivos.push(a);
      if (!a.error) for (const c of cadena) { c.todos.push(a); c.tam += a.tam; }
    }
    // Si arriba solo hay una carpeta, se enseña ya abierta.
    if (raiz.carpetas.size === 1 && raiz.archivos.length === 0) raiz.carpetas.values().next().value.abierta = true;
    return raiz;
  }

  function refrescarSeleccion() {
    for (const c of sel.controles) {
      if (c.archivo) c.input.checked = sel.ids.has(c.archivo.id);
      else {
        const n = c.nodo.todos.reduce((k, a) => k + (sel.ids.has(a.id) ? 1 : 0), 0);
        c.input.checked = n > 0 && n === c.nodo.todos.length;
        c.input.indeterminate = n > 0 && n < c.nodo.todos.length;
      }
    }
    let n = 0;
    let b = 0;
    for (const a of sel.raiz.todos) if (sel.ids.has(a.id)) { n++; b += a.tam; }
    $('sel-resumen').textContent = n ? `Elegidos: ${plural(n, 'archivo', 'archivos')} · ${tam(b)}` : 'Marca al menos un archivo';
    $('sel-aplicar').disabled = n === 0;
  }

  function nodoArchivo(a) {
    const input = el('input', { type: 'checkbox', class: 'casilla' });
    input.disabled = !!a.error;
    input.addEventListener('change', () => {
      if (input.checked) sel.ids.add(a.id); else sel.ids.delete(a.id);
      refrescarSeleccion();
    });
    if (!a.error) sel.controles.push({ archivo: a, input });
    const nombre = sel.q ? a.ruta : a.ruta.slice(a.ruta.lastIndexOf('/') + 1);
    return el('li', null, el('div', { class: 'nodo' + (a.error ? ' deshabilitado' : ''), title: a.error || a.ruta },
      el('label', null, input, el('span', { class: 'nombre', text: nombre }), el('span', { class: 'sel-meta', text: tam(a.tam) }))));
  }

  function nodoCarpeta(nodo) {
    const input = el('input', { type: 'checkbox', class: 'casilla' });
    input.disabled = nodo.todos.length === 0;
    input.addEventListener('change', () => {
      for (const a of nodo.todos) { if (input.checked) sel.ids.add(a.id); else sel.ids.delete(a.id); }
      refrescarSeleccion();
    });
    sel.controles.push({ nodo, input });
    const plegar = el('button', { type: 'button', class: 'plegar', 'aria-expanded': nodo.abierta ? 'true' : 'false', 'aria-label': `Mostrar u ocultar el contenido de ${nodo.nombre}` }, icono('flecha'));
    const hijos = el('ul');
    hijos.hidden = !nodo.abierta;
    let pintados = false;
    const pintarHijos = () => {
      if (pintados) return;
      pintados = true;
      llenar(hijos, nodo);
      refrescarSeleccion();
    };
    if (nodo.abierta) { pintados = true; llenar(hijos, nodo); }
    plegar.addEventListener('click', () => {
      nodo.abierta = !nodo.abierta;
      plegar.setAttribute('aria-expanded', nodo.abierta ? 'true' : 'false');
      hijos.hidden = !nodo.abierta;
      if (nodo.abierta) pintarHijos();
    });
    return el('li', null,
      el('div', { class: 'nodo carpeta' }, plegar,
        el('label', null, input, el('span', { class: 'nombre', text: nodo.nombre }), el('span', { class: 'sel-meta', text: `${plural(nodo.todos.length, 'archivo', 'archivos')} · ${tam(nodo.tam)}` }))),
      hijos);
  }

  // Pinta los hijos de una carpeta, por tandas si son muchos.
  function llenar(ul, nodo) {
    const carpetas = [...nodo.carpetas.values()].sort((x, y) => colator.compare(x.nombre, y.nombre));
    for (const c of carpetas) ul.append(nodoCarpeta(c));
    let n = 0;
    const tanda = () => {
      const hasta = Math.min(nodo.archivos.length, n + 300);
      const boton = ul.querySelector(':scope > li.mas-nodos');
      if (boton) boton.remove();
      for (; n < hasta; n++) ul.append(nodoArchivo(nodo.archivos[n]));
      if (n < nodo.archivos.length) {
        const b = el('button', { type: 'button', class: 'btn texto', text: `Mostrar más (quedan ${num(nodo.archivos.length - n)})` });
        b.addEventListener('click', () => { tanda(); refrescarSeleccion(); });
        ul.append(el('li', { class: 'mas-nodos' }, b));
      }
    };
    tanda();
  }

  function pintarArbol() {
    sel.controles = [{ nodo: sel.raiz, input: $('sel-todo') }];
    const caja = $('sel-arbol');
    const ul = el('ul');
    if (sel.q) {
      const hallados = s.archivos.filter((a) => a.ruta.toLowerCase().includes(sel.q));
      for (const a of hallados.slice(0, 300)) ul.append(nodoArchivo(a));
      if (!hallados.length) ul.append(el('li', { class: 'vacio', text: `Ningún archivo coincide con «${sel.q}».` }));
      else if (hallados.length > 300) ul.append(el('li', { class: 'vacio', text: `Hay ${num(hallados.length - 300)} más. Escribe algo más para afinar.` }));
    } else {
      llenar(ul, sel.raiz);
    }
    caja.replaceChildren(ul);
    $('sel-todo-meta').textContent = `${plural(sel.raiz.todos.length, 'archivo', 'archivos')} · ${tam(sel.raiz.tam)}`;
    refrescarSeleccion();
  }

  function abrirSeleccion() {
    sel.ids = new Set(s.archivos.filter((a) => a.elegido && !a.error).map((a) => a.id));
    sel.raiz = construirArbol();
    sel.q = '';
    $('sel-buscar').value = '';
    $('sel-aplicar').textContent = s.carpeta ? 'Aplicar' : 'Listo';
    pintarArbol();
    const d = $('dlg-archivos');
    if (!d.open) d.showModal();
  }
  $('sel-todo').addEventListener('change', () => {
    const marcar = $('sel-todo').checked;
    for (const a of sel.raiz.todos) { if (marcar) sel.ids.add(a.id); else sel.ids.delete(a.id); }
    refrescarSeleccion();
  });
  $('sel-buscar').addEventListener('input', () => { sel.q = $('sel-buscar').value.trim().toLowerCase(); pintarArbol(); });
  $('sel-cancelar').addEventListener('click', () => $('dlg-archivos').close());
  $('sel-aplicar').addEventListener('click', () => {
    if (!sel.ids.size) return;
    $('dlg-archivos').close();
    s.cambiarSeleccion(sel.ids);
    pintar();
  });

  /* ---------- repintado ---------- */
  function pintarYa() {
    pendiente = false;
    const v = vista(s);
    pintarTarjeta(v);
    if (v.lista) pintarLista();
    if (extras.alPintar) extras.alPintar(v);
  }
  // Agrupa los avisos de cambio: como mucho un repintado por fotograma (o por segundo si la pestaña está oculta).
  function pintar() {
    if (pendiente) return;
    pendiente = true;
    const hacer = () => { if (pendiente) pintarYa(); };
    requestAnimationFrame(hacer);
    setTimeout(hacer, 700); // con la pestaña oculta no hay fotogramas, pero el título debe seguir al día
  }

  return { pintar, pintarYa, avisar, dialogo, abrirSeleccion };
}
