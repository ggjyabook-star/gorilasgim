/* =============================================================
   PUENTE GORILAS — Lector de la base de Smart PSS Lite

   Lee directo los archivos SQLite que Smart PSS Lite crea en su
   carpeta, sin pasar por el lector físico. Sirve cuando el gimnasio
   ya tiene toda su gente cargada en Smart PSS y queremos traerla al
   sitio de un jalón.

   DOS REGLAS QUE NO SE ROMPEN:

   1. A Smart PSS Lite NO se le escribe nada. Para ni siquiera correr
      el riesgo, no se abre su archivo: se hace una COPIA a un lugar
      temporal y se lee la copia en modo solo-lectura. Si el archivo
      está bloqueado porque Smart PSS lo tiene abierto, la copia
      igual funciona.

   2. Si la base está cifrada (Smart PSS puede cifrar con llave), no
      se intenta forzarla: se detecta por la cabecera y se avisa con
      todas sus letras, para caer al camino del lector físico.

   Los nombres de archivo y de tabla salen de la propia instalación
   de Smart PSS Lite (V1.003). Como cambian entre versiones, aquí no
   se asume un esquema fijo: se abren las tablas que haya y se cosechan
   las columnas por su forma, igual que con los eventos del lector.
   ============================================================= */
'use strict';

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const os = require('os');

/* =============================================================
   1. Dónde vive Smart PSS Lite
   ============================================================= */

/* Lugares típicos de instalación en Windows. */
const CARPETAS_INSTALL = [
  'C:/Program Files/SmartPSSLite',
  'C:/Program Files (x86)/SmartPSSLite',
  'C:/Program Files/Smart PSS Lite',
  'C:/Program Files (x86)/Smart PSS Lite',
  'C:/Program Files/SmartPSS',
  'C:/Program Files (x86)/SmartPSS'
];

/* Dentro de la instalación, dónde suele estar la base viva y la plantilla. */
const SUBCARPETAS_DATOS = [
  'Data/System/Database',
  'Data/System',
  'Data',
  'Default'
];

/* Archivos que nos interesan y qué esperamos sacar de cada uno.
   'tipo' dice cómo interpretarlo; el orden es de más a menos útil. */
const ARCHIVOS = [
  { nombre: 'ACSManagerDbFile.db', tipo: 'personas', que: 'Personas y tarjetas de control de acceso' },
  { nombre: 'ACSEventInfo.db', tipo: 'eventos', que: 'Registros de acceso (entradas)' },
  { nombre: 'ResourceManagerHistory.db', tipo: 'eventos', que: 'Historial de eventos' },
  { nombre: 'ResourceManagerToday.db', tipo: 'eventos', que: 'Eventos de hoy' },
  { nombre: 'FaceRecognition.db', tipo: 'personas', que: 'Personas con rostro' },
  { nombre: 'RoleUserInfoData.db', tipo: 'operadores', que: 'Cuentas del propio Smart PSS (operadores)' }
];

/** Busca la carpeta de instalación de Smart PSS Lite. */
function ubicarInstalacion(pista) {
  const candidatos = [];
  if (pista) candidatos.push(pista);
  CARPETAS_INSTALL.forEach(function (c) { candidatos.push(c); });

  for (let i = 0; i < candidatos.length; i++) {
    try {
      if (fs.existsSync(candidatos[i]) && fs.statSync(candidatos[i]).isDirectory()) {
        return path.resolve(candidatos[i]);
      }
    } catch (e) { /* siguiente */ }
  }
  return null;
}

/**
 * Recorre la instalación y devuelve los archivos de base que existen,
 * con su tamaño y si están planos o cifrados.
 * @param {String} [pista] carpeta de instalación, si ya se conoce
 */
function explorar(pista) {
  const install = ubicarInstalacion(pista);
  if (!install) {
    return { ok: false, error: 'no_encontrado', instalacion: null, archivos: [] };
  }

  const encontrados = [];
  const yaVistos = {};

  ARCHIVOS.forEach(function (def) {
    for (let i = 0; i < SUBCARPETAS_DATOS.length; i++) {
      const ruta = path.join(install, SUBCARPETAS_DATOS[i], def.nombre);
      if (yaVistos[def.nombre]) return;
      let st;
      try { st = fs.statSync(ruta); } catch (e) { continue; }
      if (!st.isFile()) continue;

      yaVistos[def.nombre] = true;
      encontrados.push({
        nombre: def.nombre,
        tipo: def.tipo,
        que: def.que,
        ruta: ruta,
        bytes: st.size,
        estado: estadoDeArchivo(ruta)
      });
      return;
    }
  });

  return { ok: true, instalacion: install, archivos: encontrados };
}

/** Mira la cabecera: 'plano', 'cifrado', 'vacio' o 'ilegible'. */
function estadoDeArchivo(ruta) {
  try {
    const st = fs.statSync(ruta);
    if (st.size === 0) return 'vacio';
    const fd = fs.openSync(ruta, 'r');
    const buf = Buffer.alloc(16);
    fs.readSync(fd, buf, 0, 16, 0);
    fs.closeSync(fd);
    return buf.toString('latin1').startsWith('SQLite format 3') ? 'plano' : 'cifrado';
  } catch (e) {
    return 'ilegible';
  }
}

/* =============================================================
   2. Abrir una copia en solo-lectura (nunca el original)
   ============================================================= */

/**
 * Copia el .db (y sus -wal / -shm si existen) a una carpeta temporal
 * y abre la copia en modo solo-lectura. Así jamás se toca el original
 * ni importa que Smart PSS lo tenga abierto.
 * @returns {{db:DatabaseSync, limpiar:Function}}
 */
function abrirCopiaSegura(rutaOriginal) {
  const carpetaTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gorilas-spss-'));
  const base = path.basename(rutaOriginal);
  const copia = path.join(carpetaTmp, base);

  fs.copyFileSync(rutaOriginal, copia);
  /* Los diarios WAL guardan escrituras aún no volcadas; copiarlos hace
     que la copia refleje el último estado real. */
  ['-wal', '-shm'].forEach(function (suf) {
    const extra = rutaOriginal + suf;
    try { if (fs.existsSync(extra)) fs.copyFileSync(extra, copia + suf); } catch (e) { /* opcional */ }
  });

  const db = new DatabaseSync(copia, { readOnly: true });

  function limpiar() {
    try { db.close(); } catch (e) { /* ya cerrada */ }
    try { fs.rmSync(carpetaTmp, { recursive: true, force: true }); } catch (e) { /* se irá solo */ }
  }

  return { db: db, limpiar: limpiar };
}

/* =============================================================
   3. Conocer las tablas y columnas de una base
   ============================================================= */

function tablasDe(db) {
  return db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all().map(function (r) { return r.name; });
}

function columnasDe(db, tabla) {
  try {
    return db.prepare('PRAGMA table_info("' + tabla.replace(/"/g, '""') + '")').all()
      .map(function (c) { return c.name; });
  } catch (e) { return []; }
}

/** Primer nombre de columna que contenga alguno de los textos (sin acentos ni caso). */
function columnaComo(columnas, textos) {
  const bajos = columnas.map(function (c) { return String(c).toLowerCase(); });
  for (let i = 0; i < textos.length; i++) {
    const t = textos[i].toLowerCase();
    for (let j = 0; j < bajos.length; j++) {
      if (bajos[j] === t) return columnas[j];        // coincidencia exacta primero
    }
  }
  for (let i = 0; i < textos.length; i++) {
    const t = textos[i].toLowerCase();
    for (let j = 0; j < bajos.length; j++) {
      if (bajos[j].indexOf(t) >= 0) return columnas[j];
    }
  }
  return null;
}

/* =============================================================
   4. Cosechar personas
   ============================================================= */

/* Cómo se llaman, según versión, las columnas que buscamos. */
const COL_PERSONA_ID = ['UserID', 'PersonID', 'PersonId', 'UserId', 'nUserID', 'szUserID', 'ID', 'RecNo'];
const COL_NOMBRE = ['PersonName', 'UserName', 'CardName', 'Name', 'szName', 'szUserName'];
const COL_TARJETA = ['CardNo', 'CardNumber', 'CardID', 'szCardNo'];

/**
 * Recorre las tablas de una base y saca las personas que encuentre.
 * @returns {Array<{personaId, nombre, tarjeta}>}
 */
function cosecharPersonas(db) {
  const salida = [];
  const vistos = {};

  tablasDe(db).forEach(function (tabla) {
    const cols = columnasDe(db, tabla);
    if (!cols.length) return;

    const colId = columnaComo(cols, COL_PERSONA_ID);
    const colTarjeta = columnaComo(cols, COL_TARJETA);
    /* Necesita al menos un identificador de persona o de tarjeta. */
    if (!colId && !colTarjeta) return;

    const colNombre = columnaComo(cols, COL_NOMBRE);

    let filas;
    try {
      filas = db.prepare('SELECT * FROM "' + tabla.replace(/"/g, '""') + '" LIMIT 20000').all();
    } catch (e) { return; }

    filas.forEach(function (f) {
      const personaId = colId ? valor(f[colId]) : '';
      const tarjeta = colTarjeta ? valor(f[colTarjeta]) : '';
      if (!personaId && !tarjeta) return;

      const clave = (personaId || '') + '|' + (tarjeta || '');
      if (vistos[clave]) return;
      vistos[clave] = true;

      salida.push({
        personaId: personaId || tarjeta,
        nombre: colNombre ? valor(f[colNombre]) : '',
        tarjeta: tarjeta || null,
        tabla: tabla
      });
    });
  });

  return salida;
}

/* =============================================================
   5. Cosechar eventos de acceso
   ============================================================= */

const COL_FECHA = ['Time', 'EventTime', 'CreateTime', 'SwipeTime', 'OccurTime', 'nTime', 'DateTime', 'RecordTime'];
const COL_DIRECCION = ['Direction', 'InOutType', 'AttendanceState'];
const COL_METODO = ['OpenMethod', 'VerifyMethod', 'Method', 'EventType'];

/**
 * Saca registros de acceso de una base de eventos.
 * @returns {Array} con la forma que entiende base.guardarAcceso
 */
function cosecharEventos(db, partesDe) {
  const salida = [];

  tablasDe(db).forEach(function (tabla) {
    const cols = columnasDe(db, tabla);
    if (!cols.length) return;

    const colId = columnaComo(cols, COL_PERSONA_ID);
    const colTarjeta = columnaComo(cols, COL_TARJETA);
    const colFecha = columnaComo(cols, COL_FECHA);
    /* Un evento de acceso necesita a quién y cuándo. */
    if ((!colId && !colTarjeta) || !colFecha) return;

    const colNombre = columnaComo(cols, COL_NOMBRE);
    const colDir = columnaComo(cols, COL_DIRECCION);
    const colMetodo = columnaComo(cols, COL_METODO);

    let filas;
    try {
      filas = db.prepare(
        'SELECT * FROM "' + tabla.replace(/"/g, '""') + '" LIMIT 50000'
      ).all();
    } catch (e) { return; }

    filas.forEach(function (f) {
      const personaId = colId ? valor(f[colId]) : '';
      const tarjeta = colTarjeta ? valor(f[colTarjeta]) : '';
      if (!personaId && !tarjeta) return;

      const momento = interpretarMomento(f[colFecha], partesDe);
      if (!momento) return;

      salida.push({
        personaId: personaId || null,
        tarjeta: tarjeta || null,
        nombre: colNombre ? valor(f[colNombre]) : null,
        fecha: momento.fecha,
        hora: momento.hora,
        segundos: momento.segundos,
        sentido: sentidoDe(colDir ? f[colDir] : null),
        metodo: metodoDe(colMetodo ? f[colMetodo] : null),
        exito: true,
        puerta: null,
        origen: 'smartpss'
      });
    });
  });

  return salida;
}

/** Convierte lo que sea que traiga la columna de tiempo en fecha/hora locales. */
function interpretarMomento(bruto, partesDe) {
  if (bruto === null || bruto === undefined || bruto === '') return null;

  /* Texto tipo '2026-09-11 08:30:15' */
  if (typeof bruto === 'string') {
    const m = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(bruto);
    if (m) {
      return {
        fecha: m[1] + '-' + m[2] + '-' + m[3],
        hora: m[4] + ':' + m[5],
        segundos: m[4] + ':' + m[5] + ':' + (m[6] || '00')
      };
    }
  }

  /* Número: segundos o milisegundos desde 1970 (epoch). */
  const n = Number(bruto);
  if (!isNaN(n) && n > 946684800) {
    return partesDe(new Date(n < 1e11 ? n * 1000 : n));
  }

  return null;
}

function sentidoDe(bruto) {
  if (bruto === null || bruto === undefined) return 'desconocido';
  const t = String(bruto).toLowerCase();
  if (t === '0' || t === 'in' || t === 'entry' || t.indexOf('entra') >= 0) return 'entrada';
  if (t === '1' || t === 'out' || t === 'exit' || t.indexOf('sal') >= 0) return 'salida';
  return 'desconocido';
}

function metodoDe(bruto) {
  if (bruto === null || bruto === undefined) return 'otro';
  const t = String(bruto).toLowerCase();
  if (t.indexOf('face') >= 0 || t.indexOf('rostro') >= 0) return 'rostro';
  if (t.indexOf('card') >= 0 || t.indexOf('tarjeta') >= 0) return 'tarjeta';
  if (t.indexOf('finger') >= 0 || t.indexOf('huella') >= 0) return 'huella';
  if (t.indexOf('password') >= 0 || t.indexOf('pin') >= 0) return 'pin';
  return 'otro';
}

function valor(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Uint8Array) { try { return Buffer.from(v).toString('utf8').trim(); } catch (e) { return ''; } }
  return String(v).trim();
}

/* =============================================================
   6. Punto de entrada de alto nivel
   ============================================================= */

/**
 * Lee de la instalación de Smart PSS todo lo que se pueda y lo mete en
 * la base del puente, sin tocar el original.
 *
 * @param {Object} base   módulo base.js del puente (guardarPersona / guardarAcceso / partesDe)
 * @param {Object} [opts] { pista, soloExplorar }
 * @returns {Object} resumen legible
 */
function importar(base, opts) {
  const o = opts || {};
  const mapa = explorar(o.pista);

  if (!mapa.ok) {
    return { ok: false, error: 'no_encontrado', mensaje: 'No encontré Smart PSS Lite instalado en esta computadora.' };
  }
  if (!mapa.archivos.length) {
    return {
      ok: false, error: 'sin_datos', instalacion: mapa.instalacion,
      mensaje: 'Encontré Smart PSS Lite pero sin bases de datos. Seguramente todavía no se ha abierto ni cargado gente en esta computadora.'
    };
  }

  const detalle = [];
  let personasNuevas = 0, personasTotal = 0, accesosNuevos = 0, accesosTotal = 0;
  let cifradas = 0, leidas = 0;

  mapa.archivos.forEach(function (arch) {
    const linea = { archivo: arch.nombre, que: arch.que, estado: arch.estado, personas: 0, accesos: 0, nota: '' };

    if (arch.estado === 'cifrado') {
      cifradas++;
      linea.nota = 'Cifrada: no se puede leer sin la llave de Smart PSS.';
      detalle.push(linea);
      return;
    }
    if (arch.estado !== 'plano') {
      linea.nota = arch.estado === 'vacio' ? 'Archivo vacío.' : 'No se pudo leer.';
      detalle.push(linea);
      return;
    }
    if (arch.tipo === 'operadores') {
      /* Son las cuentas del propio Smart PSS (operadores del programa),
         no los socios del gimnasio. No se importan como personas. */
      linea.nota = 'Cuentas internas de Smart PSS; no son socios, se omiten.';
      detalle.push(linea);
      return;
    }
    if (o.soloExplorar) { detalle.push(linea); return; }

    let sesion;
    try {
      sesion = abrirCopiaSegura(arch.ruta);
    } catch (e) {
      linea.nota = 'No se pudo abrir una copia: ' + e.message;
      detalle.push(linea);
      return;
    }

    try {
      leidas++;
      if (arch.tipo === 'personas') {
        const gente = cosecharPersonas(sesion.db);
        gente.forEach(function (p) {
          personasTotal++;
          if (base.guardarPersona({ personaId: p.personaId, nombre: p.nombre, tarjeta: p.tarjeta })) personasNuevas++;
        });
        linea.personas = gente.length;
      } else if (arch.tipo === 'eventos') {
        const eventos = cosecharEventos(sesion.db, base.partesDe);
        eventos.forEach(function (a) {
          accesosTotal++;
          if (base.guardarAcceso(a).nuevo) accesosNuevos++;
        });
        linea.accesos = eventos.length;
      }
    } catch (e) {
      linea.nota = 'Error leyendo: ' + e.message;
    } finally {
      sesion.limpiar();
    }

    detalle.push(linea);
  });

  return {
    ok: true,
    instalacion: mapa.instalacion,
    detalle: detalle,
    resumen: {
      personasEncontradas: personasTotal,
      personasNuevas: personasNuevas,
      accesosEncontrados: accesosTotal,
      accesosNuevos: accesosNuevos,
      basesLeidas: leidas,
      basesCifradas: cifradas
    }
  };
}

module.exports = {
  explorar, importar, ubicarInstalacion,
  abrirCopiaSegura, cosecharPersonas, cosecharEventos,
  estadoDeArchivo, columnaComo
};
