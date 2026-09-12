/* =============================================================
   PUENTE GORILAS — Diagnóstico

   Se corre en la computadora del gimnasio y averigua solo todo lo
   que hace falta para conectar el sistema con el lector:

     · Qué red tiene esta computadora
     · Si Smart PSS Lite está instalado y qué bases de datos tiene
     · Si esas bases se pueden leer o están cifradas
     · Qué tablas y columnas traen (los NOMBRES, nunca los datos)
     · Qué lectores hay en la red

   IMPORTANTE — privacidad:
   Este reporte NO saca ni un solo dato personal. No lee nombres, ni
   teléfonos, ni fotos, ni tarjetas. Solo cuenta cuántos registros hay
   y cómo se llaman las columnas. Se puede compartir sin problema.

   Uso:
     node puente/diagnostico.js

   Deja el resultado en pantalla y en el archivo
   'diagnostico-gorilas.txt', junto a esta carpeta.
   ============================================================= */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const smartpss = require('./lib/smartpss');
const buscador = require('./lib/buscar');

const lineas = [];

function escribir(txt) {
  const s = txt === undefined ? '' : String(txt);
  lineas.push(s);
  console.log(s);
}

function titulo(t) {
  escribir('');
  escribir('==============================================');
  escribir('  ' + t);
  escribir('==============================================');
}

/* =============================================================
   1. Esta computadora
   ============================================================= */

function seccionEquipo() {
  titulo('1. ESTA COMPUTADORA');

  escribir('Windows:   ' + os.release() + ' (' + os.arch() + ')');
  escribir('Node.js:   ' + process.version);
  escribir('Nombre:    ' + os.hostname());
  escribir('');
  escribir('Direcciones de red:');

  const interfaces = os.networkInterfaces();
  let hayRed = false;

  for (const nombre in interfaces) {
    if (!Object.prototype.hasOwnProperty.call(interfaces, nombre)) continue;
    (interfaces[nombre] || []).forEach(function (dir) {
      if (dir.family !== 'IPv4' || dir.internal) return;
      hayRed = true;
      const red = dir.address.split('.').slice(0, 3).join('.');
      escribir('   ' + dir.address.padEnd(16) + ' (' + nombre + ')   red: ' + red + '.x');
    });
  }

  if (!hayRed) {
    escribir('   ⚠ No encontré ninguna red. ¿Está conectada al WiFi o al cable?');
  }
}

/* =============================================================
   2. Smart PSS Lite
   ============================================================= */

function seccionSmartPss() {
  titulo('2. SMART PSS LITE');

  const mapa = smartpss.explorar();

  if (!mapa.ok || !mapa.instalacion) {
    escribir('✗ NO está instalado en esta computadora.');
    escribir('');
    escribir('  Si el gimnasio lo usa, este diagnóstico hay que correrlo en');
    escribir('  LA COMPUTADORA DONDE ESTÁ INSTALADO, no en otra.');
    return;
  }

  escribir('✓ Instalado en: ' + mapa.instalacion);
  escribir('');

  if (!mapa.archivos.length) {
    escribir('⚠ No tiene bases de datos todavía.');
    escribir('');
    escribir('  Esto pasa cuando el programa está instalado pero NUNCA se ha');
    escribir('  abierto en esta computadora, o no se le ha cargado gente.');
    escribir('  Sin datos aquí, hay que traerlos del lector directamente.');
    return;
  }

  escribir('Bases de datos encontradas: ' + mapa.archivos.length);
  escribir('');

  mapa.archivos.forEach(function (arch) {
    const kb = Math.round((arch.bytes || 0) / 1024);
    escribir('--- ' + arch.nombre + ' ---');
    escribir('    Qué trae:  ' + arch.que);
    escribir('    Tamaño:    ' + kb + ' KB');
    escribir('    Estado:    ' + etiquetaEstado(arch.estado));

    if (arch.estado !== 'plano') { escribir(''); return; }

    /* Solo nombres de tabla y columna, y cuántas filas. Cero datos. */
    let sesion;
    try {
      sesion = smartpss.abrirCopiaSegura(arch.ruta);
    } catch (e) {
      escribir('    No se pudo abrir una copia: ' + e.message);
      escribir('');
      return;
    }

    try {
      const tablas = sesion.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      ).all();

      if (!tablas.length) {
        escribir('    (sin tablas)');
      } else {
        escribir('    Tablas: ' + tablas.length);
        tablas.forEach(function (t) {
          let filas = '?';
          try {
            const c = sesion.db.prepare('SELECT COUNT(*) AS n FROM "' + t.name.replace(/"/g, '""') + '"').get();
            filas = String((c && c.n) || 0);
          } catch (e) { /* tabla rara, se deja en ? */ }

          let cols = [];
          try {
            cols = sesion.db.prepare('PRAGMA table_info("' + t.name.replace(/"/g, '""') + '")')
              .all().map(function (c) { return c.name; });
          } catch (e) { /* sin columnas */ }

          escribir('      · ' + t.name.padEnd(28) + filas.padStart(7) + ' filas');
          if (cols.length) {
            escribir('        columnas: ' + cols.join(', ').slice(0, 200));
          }
        });
      }
    } catch (e) {
      escribir('    Error leyendo: ' + e.message);
    } finally {
      sesion.limpiar();
    }
    escribir('');
  });
}

function etiquetaEstado(e) {
  if (e === 'plano') return 'SE PUEDE LEER (SQLite normal)';
  if (e === 'cifrado') return 'CIFRADA — hace falta la llave de Smart PSS';
  if (e === 'vacio') return 'vacía';
  return 'no se pudo leer';
}

/* =============================================================
   3. Lectores en la red
   ============================================================= */

async function seccionLectores() {
  titulo('3. LECTORES EN LA RED');

  escribir('Revisando la red… esto tarda hasta un minuto, espera.');
  escribir('');

  let r;
  try {
    r = await buscador.buscar({});
  } catch (e) {
    escribir('✗ No se pudo revisar la red: ' + e.message);
    return;
  }

  if (r.error === 'sin_red') {
    escribir('✗ Esta computadora no está en ninguna red.');
    return;
  }

  escribir('Red revisada: ' + (r.red || '?') + '.x');
  escribir('');

  if (!r.candidatos || !r.candidatos.length) {
    escribir('✗ No encontré ningún lector en esta red.');
    escribir('');
    escribir('  Puede ser que:');
    escribir('   · el lector esté en otra red distinta a esta computadora');
    escribir('   · esté apagado o desconectado');
    escribir('   · use un puerto diferente al 80');
    return;
  }

  escribir('✓ Encontré ' + r.candidatos.length + ' equipo(s) que parecen lector:');
  escribir('');
  r.candidatos.forEach(function (c) {
    escribir('   IP: ' + c.ip);
    escribir('      Modelo probable: ' + (c.modeloProbable || c.realm || 'no dice'));
    escribir('      Puerto Dahua (37777): ' + (c.puertoDahua ? 'abierto' : 'cerrado'));
    escribir('      Su página web: http://' + c.ip);
    escribir('');
  });
}

/* =============================================================
   4. Resumen y qué sigue
   ============================================================= */

function seccionResumen(mapa, candidatos) {
  titulo('4. QUÉ SIGUE');

  const tieneSpss = mapa && mapa.ok && mapa.archivos && mapa.archivos.length > 0;
  const puedeLeer = tieneSpss && mapa.archivos.some(function (a) { return a.estado === 'plano'; });
  const tieneLector = candidatos && candidatos.length > 0;

  if (puedeLeer) {
    escribir('✓ Se puede traer la gente que ya está cargada en Smart PSS Lite,');
    escribir('  leyendo su base de datos directamente (no se le escribe nada).');
  } else if (tieneSpss) {
    escribir('⚠ Smart PSS Lite tiene bases pero están cifradas o vacías.');
    escribir('  Habrá que traer los datos del lector directamente.');
  } else {
    escribir('⚠ No hay datos de Smart PSS Lite en esta computadora.');
  }

  escribir('');

  if (tieneLector) {
    escribir('✓ Hay un lector en la red. Falta:');
    escribir('    1. La contraseña de administrador del lector.');
    escribir('    2. Encender el envío de eventos HTTP en su página web,');
    escribir('       apuntando a la IP de ESTA computadora, puerto 80, ruta /');
  } else {
    escribir('⚠ No se ve ningún lector desde aquí. Hay que revisar que esta');
    escribir('  computadora esté en la MISMA red que el lector.');
  }

  escribir('');
  escribir('Para prender el sistema:  doble clic en ABRIR-CON-LECTOR.bat');
}

/* =============================================================
   Arranque
   ============================================================= */

async function correr() {
  escribir('');
  escribir('  DIAGNÓSTICO — GORILAS GYM + LECTOR DE ACCESO');
  escribir('  Fecha: ' + new Date().toLocaleString());
  escribir('');
  escribir('  Este reporte NO contiene datos personales de nadie:');
  escribir('  solo nombres de tablas, conteos y direcciones de red.');

  seccionEquipo();

  let mapa = null;
  try {
    mapa = smartpss.explorar();
  } catch (e) { /* se reporta abajo */ }
  seccionSmartPss();

  let candidatos = [];
  try {
    await seccionLectores();
    const r = await buscador.buscar({});
    candidatos = r.candidatos || [];
  } catch (e) { /* ya se reportó */ }

  seccionResumen(mapa, candidatos);

  const destino = path.join(__dirname, '..', 'diagnostico-gorilas.txt');
  try {
    fs.writeFileSync(destino, lineas.join('\r\n'), 'utf8');
    escribir('');
    escribir('==============================================');
    escribir('  Reporte guardado en:');
    escribir('  ' + destino);
    escribir('  Manda ESE archivo y con eso se termina de conectar.');
    escribir('==============================================');
  } catch (e) {
    console.log('No se pudo guardar el archivo: ' + e.message);
  }
}

correr();
