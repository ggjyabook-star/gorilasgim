/* =============================================================
   PUENTE GORILAS — Base de datos compartida (SQLite)
   Usa el SQLite que ya trae Node 22+ (node:sqlite). Sin dependencias.

   Aquí vive lo que el lector nos da y el sitio no tenía:
     eventos_crudos  todo lo que llega tal cual (para diagnosticar)
     accesos         cada entrada/salida ya interpretada
     personas        la gente que el lector conoce
     vinculos        persona del lector  <->  socio del sitio
     config          ajustes que sobreviven al reinicio

   Nunca se escribe en la base de Smart PSS Lite. Esta es aparte.
   ============================================================= */
'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const ESQUEMA = [
  `CREATE TABLE IF NOT EXISTS eventos_crudos (
     id             INTEGER PRIMARY KEY AUTOINCREMENT,
     recibido_en    TEXT NOT NULL,
     ip             TEXT,
     ruta           TEXT,
     tipo_contenido TEXT,
     bytes          INTEGER,
     cuerpo         TEXT,
     interpretado   INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS accesos (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     huella      TEXT NOT NULL UNIQUE,
     persona_id  TEXT,
     tarjeta     TEXT,
     nombre      TEXT,
     fecha       TEXT NOT NULL,
     hora        TEXT NOT NULL,
     segundos    TEXT,
     sentido     TEXT NOT NULL DEFAULT 'desconocido',
     metodo      TEXT,
     exito       INTEGER NOT NULL DEFAULT 1,
     puerta      TEXT,
     origen      TEXT NOT NULL DEFAULT 'push',
     recibido_en TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_accesos_fecha   ON accesos (fecha)`,
  `CREATE INDEX IF NOT EXISTS idx_accesos_persona ON accesos (persona_id)`,
  `CREATE TABLE IF NOT EXISTS personas (
     persona_id  TEXT PRIMARY KEY,
     nombre      TEXT,
     tarjeta     TEXT,
     primera_vez TEXT,
     ultima_vez  TEXT,
     veces       INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS vinculos (
     persona_id   TEXT PRIMARY KEY,
     socio_id     TEXT NOT NULL,
     socio_nombre TEXT,
     vinculado_en TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_vinculos_socio ON vinculos (socio_id)`,
  `CREATE TABLE IF NOT EXISTS config (
     clave TEXT PRIMARY KEY,
     valor TEXT
   )`
].join(';\n') + ';';

let db = null;

/* =============================================================
   Fechas locales (nunca UTC: el día no se debe perder)
   ============================================================= */

function dos(n) { return (n < 10 ? '0' : '') + n; }

/** Date -> { fecha:'YYYY-MM-DD', hora:'HH:MM', segundos:'HH:MM:SS' } en hora local. */
function partesDe(f) {
  const d = (f instanceof Date && !isNaN(f.getTime())) ? f : new Date();
  return {
    fecha: d.getFullYear() + '-' + dos(d.getMonth() + 1) + '-' + dos(d.getDate()),
    hora: dos(d.getHours()) + ':' + dos(d.getMinutes()),
    segundos: dos(d.getHours()) + ':' + dos(d.getMinutes()) + ':' + dos(d.getSeconds())
  };
}

/** Marca de tiempo local legible, para las columnas *_en. */
function ahora() {
  const p = partesDe(new Date());
  return p.fecha + ' ' + p.segundos;
}

/* =============================================================
   Apertura
   ============================================================= */

/**
 * Abre (y crea si hace falta) la base del puente.
 * @param {String} archivo ruta del .db
 * @returns {String} ruta absoluta del archivo
 */
function abrir(archivo) {
  const destino = path.resolve(archivo);
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  db = new DatabaseSync(destino);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(ESQUEMA);
  return destino;
}

function requiere() {
  if (!db) throw new Error('La base del puente no está abierta.');
  return db;
}

/* =============================================================
   Eventos crudos
   ============================================================= */

/** Guarda tal cual lo que llegó del lector; devuelve su id. */
function guardarCrudo(datos) {
  const r = requiere().prepare(
    'INSERT INTO eventos_crudos (recibido_en, ip, ruta, tipo_contenido, bytes, cuerpo)' +
    ' VALUES (?, ?, ?, ?, ?, ?)'
  ).run(ahora(), datos.ip || '', datos.ruta || '', datos.tipoContenido || '',
        Number(datos.bytes) || 0, datos.cuerpo || '');
  return Number(r.lastInsertRowid);
}

function marcarInterpretado(idCrudo) {
  requiere().prepare('UPDATE eventos_crudos SET interpretado = 1 WHERE id = ?').run(Number(idCrudo));
}

function crudosRecientes(limite) {
  return requiere().prepare(
    'SELECT * FROM eventos_crudos ORDER BY id DESC LIMIT ?'
  ).all(Math.min(Number(limite) || 20, 200));
}

/** Deja solo los últimos N eventos crudos (son solo para diagnóstico). */
function podarCrudos(conservar) {
  const n = Math.max(Number(conservar) || 500, 50);
  requiere().prepare(
    'DELETE FROM eventos_crudos WHERE id <= (SELECT MAX(id) - ? FROM eventos_crudos)'
  ).run(n);
}

/* =============================================================
   Accesos
   ============================================================= */

/** Identidad de un acceso: si llega dos veces (push y consulta) no se duplica. */
function huellaDe(a) {
  return [
    a.personaId || a.tarjeta || 'anon',
    a.fecha,
    a.segundos || a.hora,
    a.puerta || '0'
  ].join('|');
}

/**
 * Registra un acceso. Si ya existía (misma huella) no vuelve a insertarlo.
 * @returns {{id:Number, nuevo:Boolean}}
 */
function guardarAcceso(a) {
  const base = requiere();
  const huella = huellaDe(a);

  const previo = base.prepare('SELECT id FROM accesos WHERE huella = ?').get(huella);
  if (previo) return { id: Number(previo.id), nuevo: false };

  const r = base.prepare(
    'INSERT INTO accesos' +
    ' (huella, persona_id, tarjeta, nombre, fecha, hora, segundos,' +
    '  sentido, metodo, exito, puerta, origen, recibido_en)' +
    ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(huella, a.personaId || null, a.tarjeta || null, a.nombre || null,
        a.fecha, a.hora, a.segundos || null, a.sentido || 'desconocido',
        a.metodo || null, a.exito === false ? 0 : 1, a.puerta || null,
        a.origen || 'push', ahora());

  if (a.personaId) tocarPersona(a);
  return { id: Number(r.lastInsertRowid), nuevo: true };
}

/** Accesos con id mayor a 'desdeId' — así el sitio sincroniza solo lo nuevo. */
function accesosNuevos(desdeId, limite) {
  return requiere().prepare(
    'SELECT a.*, v.socio_id AS socio_id' +
    '  FROM accesos a' +
    '  LEFT JOIN vinculos v ON v.persona_id = a.persona_id' +
    ' WHERE a.id > ?' +
    ' ORDER BY a.id ASC' +
    ' LIMIT ?'
  ).all(Number(desdeId) || 0, Math.min(Number(limite) || 500, 2000));
}

function accesosDelRango(desde, hasta, limite) {
  return requiere().prepare(
    'SELECT a.*, v.socio_id AS socio_id' +
    '  FROM accesos a' +
    '  LEFT JOIN vinculos v ON v.persona_id = a.persona_id' +
    ' WHERE a.fecha >= ? AND a.fecha <= ?' +
    ' ORDER BY a.fecha DESC, a.hora DESC, a.id DESC' +
    ' LIMIT ?'
  ).all(String(desde), String(hasta), Math.min(Number(limite) || 200, 2000));
}

function ultimoAcceso() {
  return requiere().prepare('SELECT * FROM accesos ORDER BY id DESC LIMIT 1').get() || null;
}

function maxAccesoId() {
  const r = requiere().prepare('SELECT MAX(id) AS n FROM accesos').get();
  return Number((r && r.n) || 0);
}

/* =============================================================
   Personas
   ============================================================= */

/** Alta o actualización de la persona que acaba de pasar por el lector. */
function tocarPersona(a) {
  const base = requiere();
  const hoy = ahora();
  const existe = base.prepare('SELECT persona_id FROM personas WHERE persona_id = ?').get(a.personaId);

  if (existe) {
    base.prepare(
      'UPDATE personas' +
      '   SET nombre     = COALESCE(NULLIF(?, \'\'), nombre),' +
      '       tarjeta    = COALESCE(NULLIF(?, \'\'), tarjeta),' +
      '       primera_vez = COALESCE(primera_vez, ?),' +
      '       ultima_vez = ?,' +
      '       veces      = veces + 1' +
      ' WHERE persona_id = ?'
    ).run(a.nombre || '', a.tarjeta || '', hoy, hoy, a.personaId);
    return;
  }
  base.prepare(
    'INSERT INTO personas (persona_id, nombre, tarjeta, primera_vez, ultima_vez, veces)' +
    ' VALUES (?, ?, ?, ?, ?, 1)'
  ).run(a.personaId, a.nombre || null, a.tarjeta || null, hoy, hoy);
}

/** Alta de una persona traída del lector (aunque todavía no haya pasado). */
function guardarPersona(p) {
  const base = requiere();
  const existe = base.prepare('SELECT persona_id FROM personas WHERE persona_id = ?').get(p.personaId);
  if (existe) {
    base.prepare(
      'UPDATE personas SET nombre  = COALESCE(NULLIF(?, \'\'), nombre),' +
      '                    tarjeta = COALESCE(NULLIF(?, \'\'), tarjeta)' +
      ' WHERE persona_id = ?'
    ).run(p.nombre || '', p.tarjeta || '', p.personaId);
    return false;
  }
  base.prepare(
    'INSERT INTO personas (persona_id, nombre, tarjeta, primera_vez, ultima_vez, veces)' +
    ' VALUES (?, ?, ?, NULL, NULL, 0)'
  ).run(String(p.personaId), p.nombre || null, p.tarjeta || null);
  return true;
}

function personas() {
  return requiere().prepare(
    'SELECT p.*, v.socio_id, v.socio_nombre' +
    '  FROM personas p' +
    '  LEFT JOIN vinculos v ON v.persona_id = p.persona_id' +
    ' ORDER BY (v.socio_id IS NULL) DESC, p.ultima_vez DESC, p.persona_id ASC'
  ).all();
}

function sinVincular() {
  const r = requiere().prepare(
    'SELECT COUNT(*) AS n FROM personas p' +
    ' LEFT JOIN vinculos v ON v.persona_id = p.persona_id' +
    ' WHERE v.socio_id IS NULL'
  ).get();
  return Number((r && r.n) || 0);
}

/* =============================================================
   Vínculos
   ============================================================= */

function vincular(personaId, socioId, socioNombre) {
  requiere().prepare(
    'INSERT INTO vinculos (persona_id, socio_id, socio_nombre, vinculado_en)' +
    ' VALUES (?, ?, ?, ?)' +
    ' ON CONFLICT(persona_id) DO UPDATE' +
    '    SET socio_id     = excluded.socio_id,' +
    '        socio_nombre = excluded.socio_nombre,' +
    '        vinculado_en = excluded.vinculado_en'
  ).run(String(personaId), String(socioId), socioNombre || null, ahora());
}

function desvincular(personaId) {
  requiere().prepare('DELETE FROM vinculos WHERE persona_id = ?').run(String(personaId));
}

function vinculos() {
  return requiere().prepare('SELECT * FROM vinculos ORDER BY vinculado_en DESC').all();
}

/* =============================================================
   Config
   ============================================================= */

function leerConfig(clave, porDefecto) {
  const r = requiere().prepare('SELECT valor FROM config WHERE clave = ?').get(String(clave));
  if (r && r.valor !== null && r.valor !== undefined) return r.valor;
  return porDefecto === undefined ? null : porDefecto;
}

function escribirConfig(clave, valor) {
  requiere().prepare(
    'INSERT INTO config (clave, valor) VALUES (?, ?)' +
    ' ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor'
  ).run(String(clave), valor === null || valor === undefined ? null : String(valor));
}

/* =============================================================
   Conteos para la pantalla de estado
   ============================================================= */

function conteos() {
  const base = requiere();
  function uno(sql, arg) {
    const fila = arg === undefined ? base.prepare(sql).get() : base.prepare(sql).get(arg);
    return Number((fila && fila.n) || 0);
  }
  return {
    accesos: uno('SELECT COUNT(*) AS n FROM accesos'),
    accesosHoy: uno('SELECT COUNT(*) AS n FROM accesos WHERE fecha = ?', partesDe(new Date()).fecha),
    personas: uno('SELECT COUNT(*) AS n FROM personas'),
    vinculos: uno('SELECT COUNT(*) AS n FROM vinculos'),
    sinVincular: sinVincular(),
    crudos: uno('SELECT COUNT(*) AS n FROM eventos_crudos')
  };
}

function cerrar() {
  if (!db) return;
  try { db.close(); } catch (e) { /* ya estaba cerrada */ }
  db = null;
}

module.exports = {
  abrir, cerrar, ahora, partesDe,
  guardarCrudo, marcarInterpretado, crudosRecientes, podarCrudos,
  guardarAcceso, accesosNuevos, accesosDelRango, ultimoAcceso, maxAccesoId,
  guardarPersona, personas, sinVincular,
  vincular, desvincular, vinculos,
  leerConfig, escribirConfig, conteos
};
