// Textos de cifras para la interfaz (español).

const KB = 1024;
const MB = 1048576;
const GB = 1073741824;

export function num(n, dec = 0) {
  return n.toLocaleString('es-ES', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

export function plural(n, uno, varios) {
  return num(n) + ' ' + (n === 1 ? uno : varios);
}

const decimales = (v) => (v >= 100 ? 0 : 1);

// Tamaño legible. Usa unidades binarias con los nombres de siempre, como el Explorador de Windows.
export function tam(b) {
  if (!(b > 0)) return '0 KB';
  if (b >= GB) return num(b / GB, decimales(b / GB)) + ' GB';
  if (b >= MB) return num(b / MB, decimales(b / MB)) + ' MB';
  if (b >= KB) return num(Math.round(b / KB)) + ' KB';
  return plural(b, 'byte', 'bytes');
}

export function velocidad(bps) {
  if (!(bps > 0)) return '';
  if (bps >= MB) return num(bps / MB, decimales(bps / MB)) + ' MB/s';
  return num(Math.max(1, Math.round(bps / KB))) + ' KB/s';
}

// Tiempo restante, redondeado para no bailar: «quedan unas 2 h 40 min».
export function restante(seg) {
  if (!isFinite(seg) || seg <= 0) return '';
  if (seg < 60) return 'queda menos de 1 min';
  const min = Math.round(seg / 60);
  if (min < 60) return 'quedan unos ' + min + ' min';
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h >= 48) return 'quedan unos ' + Math.round(h / 24) + ' días';
  return (h === 1 ? 'queda 1 h' : 'quedan unas ' + h + ' h') + (m ? ' ' + m + ' min' : '');
}

// Duración transcurrida: «3 h 12 min», «4 min», «25 s».
export function duracion(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + ' s';
  const min = Math.round(s / 60);
  if (min < 60) return min + ' min';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h + ' h' + (m ? ' ' + m + ' min' : '');
}

export function porcentaje(hecho, total) {
  if (!(total > 0)) return hecho > 0 ? 100 : 0;
  const p = Math.floor((hecho / total) * 100);
  return Math.max(0, Math.min(100, p));
}
