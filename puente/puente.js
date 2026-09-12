/* =============================================================
   PUENTE GORILAS — Servidor único

   Hace tres cosas a la vez:
     1. Sirve el sitio (lo mismo que server.js, pero con API).
     2. Escucha lo que el lector empuja por HTTP y lo guarda.
     3. Expone /api para que el sitio lea accesos y personas.

   Arranque:   node puente/puente.js
   Sitio:      http://localhost:5173
   Receptor:   puerto 80 de esta computadora (configurable)

   No necesita usuario ni contraseña del lector para recibir:
   el empuje de eventos no los pide. Las credenciales solo hacen
   falta para consultarle cosas al lector (segunda etapa).

   Nunca toca la base de Smart PSS Lite.
   ============================================================= */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const base = require('./lib/base');
const eventos = require('./lib/eventos');
const lector = require('./lib/lector');
const buscador = require('./lib/buscar');
const smartpss = require('./lib/smartpss');

/* =============================================================
   Configuración
   ============================================================= */

const RAIZ_SITIO = path.resolve(__dirname, '..');
const ARCHIVO_CONFIG = path.join(__dirname, 'config.json');

const POR_DEFECTO = {
  puertoSitio: 5173,
  puertoReceptor: 80,
  archivoBase: path.join(__dirname, 'datos', 'puente.db'),
  lector: { ip: '', puerto: 80, usuario: 'admin', contrasena: '' },
  smartpssRuta: '',
  conservarEventosCrudos: 500
};

function leerConfig() {
  let guardada = {};
  try {
    if (fs.existsSync(ARCHIVO_CONFIG)) {
      guardada = JSON.parse(fs.readFileSync(ARCHIVO_CONFIG, 'utf8'));
    }
  } catch (e) {
    console.log('  ⚠  config.json tiene un error de formato; se usan los valores por defecto.');
  }
  const cfg = Object.assign({}, POR_DEFECTO, guardada);
  cfg.lector = Object.assign({}, POR_DEFECTO.lector, guardada.lector || {});
  return cfg;
}

function guardarConfig(cfg) {
  const copia = {
    puertoSitio: cfg.puertoSitio,
    puertoReceptor: cfg.puertoReceptor,
    lector: cfg.lector,
    smartpssRuta: cfg.smartpssRuta || '',
    conservarEventosCrudos: cfg.conservarEventosCrudos
  };
  fs.writeFileSync(ARCHIVO_CONFIG, JSON.stringify(copia, null, 2), 'utf8');
}

let config = leerConfig();

/* Estado vivo, para la pantalla de diagnóstico. */
const estado = {
  arrancadoEn: base.ahora(),
  ultimoLatido: null,
  ultimoEvento: null,
  eventosRecibidos: 0,
  receptorEnPuerto: null,
  receptorError: ''
};

/* =============================================================
   Utilidades de respuesta
   ============================================================= */

function json(res, datos, codigo) {
  const cuerpo = JSON.stringify(datos);
  res.writeHead(codigo || 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    /* El sitio puede estar abierto como archivo o desde otro puerto. */
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS'
  });
  res.end(cuerpo);
}

function leerCuerpo(req, limiteBytes) {
  return new Promise(function (resolver) {
    const trozos = [];
    let total = 0;
    const tope = limiteBytes || 8 * 1024 * 1024;

    req.on('data', function (d) {
      total += d.length;
      if (total <= tope) trozos.push(d);
    });
    req.on('end', function () {
      resolver({ buffer: Buffer.concat(trozos), bytes: total });
    });
    req.on('error', function () { resolver({ buffer: Buffer.alloc(0), bytes: 0 }); });
  });
}

/* =============================================================
   Receptor de eventos del lector
   ============================================================= */

/**
 * Atiende cualquier POST que no sea de /api: lo guarda crudo, lo
 * interpreta y registra los accesos que traiga.
 *
 * Siempre contesta 200: si el lector recibe un error, deja de
 * mandar eventos o los reintenta sin parar.
 */
async function recibirDelLector(req, res, ruta) {
  const { buffer, bytes } = await leerCuerpo(req);

  /* Para guardar y diagnosticar se usa UTF-8, que es como el lector
     manda los nombres. El intérprete recibe el buffer completo y él
     decide la codificación (vuelve a intentar en latin1 si hace falta). */
  const texto = buffer.toString('utf8');
  const tipoContenido = req.headers['content-type'] || '';
  const ip = (req.socket.remoteAddress || '').replace('::ffff:', '');

  estado.eventosRecibidos++;

  let idCrudo = 0;
  try {
    idCrudo = base.guardarCrudo({
      ip: ip,
      ruta: ruta,
      tipoContenido: tipoContenido,
      bytes: bytes,
      /* Se recorta: las fotos no aportan al diagnóstico. */
      cuerpo: texto.length > 20000 ? texto.slice(0, 20000) + '…[recortado]' : texto
    });
  } catch (e) {
    console.log('  ⚠  No se pudo guardar el evento crudo:', e.message);
  }

  let resultado = { tipo: 'desconocido', accesos: [] };
  try {
    resultado = eventos.deCuerpo(buffer, tipoContenido);
  } catch (e) {
    console.log('  ⚠  Error interpretando el evento:', e.message);
  }

  if (resultado.tipo === 'latido') {
    estado.ultimoLatido = base.ahora();
  }

  let nuevos = 0;
  resultado.accesos.forEach(function (a) {
    try {
      const r = base.guardarAcceso(a);
      if (r.nuevo) {
        nuevos++;
        estado.ultimoEvento = base.ahora();
        console.log('  ✓ Acceso: ' + (a.nombre || a.personaId || a.tarjeta || '?') +
          '  ' + a.fecha + ' ' + (a.segundos || a.hora) +
          '  [' + a.metodo + (a.exito ? '' : ' · RECHAZADO') + ']');
      }
    } catch (e) {
      console.log('  ⚠  No se pudo guardar el acceso:', e.message);
    }
  });

  if (idCrudo && (resultado.tipo !== 'desconocido' || nuevos)) {
    try { base.marcarInterpretado(idCrudo); } catch (e) { /* no es grave */ }
  }

  if (estado.eventosRecibidos % 50 === 0) {
    try { base.podarCrudos(config.conservarEventosCrudos); } catch (e) { /* no es grave */ }
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
}

/* =============================================================
   API para el sitio
   ============================================================= */

async function atenderApi(req, res, ruta, params) {
  /* ---------- Estado general ---------- */
  if (ruta === '/api/estado') {
    return json(res, {
      ok: true,
      puente: {
        arrancadoEn: estado.arrancadoEn,
        eventosRecibidos: estado.eventosRecibidos,
        ultimoLatido: estado.ultimoLatido,
        ultimoEvento: estado.ultimoEvento,
        receptorEnPuerto: estado.receptorEnPuerto,
        receptorError: estado.receptorError,
        ipsDeEstaPc: ipsLocales()
      },
      lector: {
        configurado: !!config.lector.ip,
        ip: config.lector.ip,
        puerto: config.lector.puerto,
        usuario: config.lector.usuario,
        tieneContrasena: !!config.lector.contrasena
      },
      conteos: base.conteos(),
      ultimoAcceso: base.ultimoAcceso(),
      cursor: base.maxAccesoId()
    });
  }

  /* ---------- Accesos nuevos (sincronización del sitio) ---------- */
  if (ruta === '/api/accesos/nuevos') {
    const desdeId = Number(params.desdeId) || 0;
    const lista = base.accesosNuevos(desdeId, Number(params.limite) || 500);
    return json(res, {
      ok: true,
      accesos: lista,
      cursor: lista.length ? Number(lista[lista.length - 1].id) : desdeId
    });
  }

  /* ---------- Accesos por rango ---------- */
  if (ruta === '/api/accesos') {
    const hoy = base.partesDe(new Date()).fecha;
    return json(res, {
      ok: true,
      accesos: base.accesosDelRango(params.desde || hoy, params.hasta || hoy, params.limite)
    });
  }

  /* ---------- Personas conocidas por el lector ---------- */
  if (ruta === '/api/personas') {
    return json(res, { ok: true, personas: base.personas() });
  }

  /* ---------- Vínculos persona <-> socio ---------- */
  if (ruta === '/api/vinculos' && req.method === 'GET') {
    return json(res, { ok: true, vinculos: base.vinculos() });
  }

  if (ruta === '/api/vinculos' && req.method === 'POST') {
    const cuerpo = await leerCuerpo(req, 64 * 1024);
    let datos = {};
    try { datos = JSON.parse(cuerpo.buffer.toString('utf8') || '{}'); } catch (e) { /* queda vacío */ }

    if (!datos.personaId || !datos.socioId) {
      return json(res, { ok: false, error: 'Faltan personaId y socioId.' }, 400);
    }
    base.vincular(datos.personaId, datos.socioId, datos.socioNombre);
    return json(res, { ok: true });
  }

  if (ruta === '/api/vinculos' && req.method === 'DELETE') {
    if (!params.personaId) return json(res, { ok: false, error: 'Falta personaId.' }, 400);
    base.desvincular(params.personaId);
    return json(res, { ok: true });
  }

  /* ---------- Diagnóstico: lo que llegó tal cual ---------- */
  if (ruta === '/api/crudos') {
    return json(res, { ok: true, eventos: base.crudosRecientes(params.limite) });
  }

  /* ---------- Lector: buscar en la red ---------- */
  if (ruta === '/api/lector/buscar') {
    const r = await buscador.buscar({ red: params.red, puerto: params.puerto });
    return json(res, Object.assign({ ok: true }, r));
  }

  /* ---------- Lector: guardar credenciales ---------- */
  if (ruta === '/api/lector/config' && req.method === 'POST') {
    const cuerpo = await leerCuerpo(req, 64 * 1024);
    let datos = {};
    try { datos = JSON.parse(cuerpo.buffer.toString('utf8') || '{}'); } catch (e) { /* queda vacío */ }

    config.lector = {
      ip: String(datos.ip || '').trim(),
      puerto: Number(datos.puerto) || 80,
      usuario: String(datos.usuario || 'admin').trim(),
      contrasena: datos.contrasena === undefined ? config.lector.contrasena : String(datos.contrasena)
    };
    guardarConfig(config);
    return json(res, { ok: true, lector: { ip: config.lector.ip, puerto: config.lector.puerto } });
  }

  /* ---------- Lector: probar conexión ---------- */
  if (ruta === '/api/lector/probar') {
    if (!config.lector.ip) return json(res, { ok: false, error: 'Todavía no hay IP del lector.' });
    const r = await lector.probar(config.lector);
    return json(res, r);
  }

  /* ---------- Lector: importar sus personas ---------- */
  if (ruta === '/api/lector/personas' && req.method === 'POST') {
    if (!config.lector.ip) return json(res, { ok: false, error: 'Todavía no hay IP del lector.' });
    const r = await lector.personas(config.lector);
    if (!r.ok) return json(res, r);

    let nuevas = 0;
    r.personas.forEach(function (p) { if (base.guardarPersona(p)) nuevas++; });
    return json(res, { ok: true, total: r.personas.length, nuevas: nuevas });
  }

  /* ---------- Smart PSS Lite: ver qué bases hay ---------- */
  if (ruta === '/api/smartpss/explorar') {
    const mapa = smartpss.explorar(config.smartpssRuta || params.ruta || '');
    return json(res, Object.assign({ ok: mapa.ok }, mapa));
  }

  /* ---------- Smart PSS Lite: importar personas y accesos ---------- */
  if (ruta === '/api/smartpss/importar' && req.method === 'POST') {
    const cuerpo = await leerCuerpo(req, 64 * 1024);
    let datos = {};
    try { datos = JSON.parse(cuerpo.buffer.toString('utf8') || '{}'); } catch (e) { /* queda vacío */ }

    const pista = String(datos.ruta || config.smartpssRuta || '');
    const r = smartpss.importar(base, { pista: pista });

    /* Si el usuario dio una ruta buena, se recuerda para la próxima. */
    if (r.ok && pista && r.instalacion) {
      config.smartpssRuta = r.instalacion;
      guardarConfig(config);
    }
    return json(res, r);
  }

  /* ---------- Lector: traer registros viejos ---------- */
  if (ruta === '/api/lector/registros' && req.method === 'POST') {
    if (!config.lector.ip) return json(res, { ok: false, error: 'Todavía no hay IP del lector.' });

    const hoy = base.partesDe(new Date()).fecha;
    const r = await lector.registros(config.lector, params.desde || hoy, params.hasta || hoy);
    if (!r.ok) return json(res, r);

    let nuevos = 0;
    r.registros.forEach(function (fila) {
      const interpretado = eventos.interpretar(fila);
      interpretado.accesos.forEach(function (a) {
        a.origen = 'consulta';
        if (base.guardarAcceso(a).nuevo) nuevos++;
      });
    });
    return json(res, { ok: true, total: r.registros.length, nuevos: nuevos });
  }

  return json(res, { ok: false, error: 'Ruta no encontrada: ' + ruta }, 404);
}

/* =============================================================
   Sitio estático
   ============================================================= */

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.md': 'text/plain; charset=utf-8'
};

function servirSitio(req, res, ruta) {
  let destino = ruta === '/' ? '/index.html' : ruta;
  const archivo = path.normalize(path.join(RAIZ_SITIO, destino));

  if (!archivo.startsWith(RAIZ_SITIO)) {
    res.writeHead(403).end('Prohibido');
    return;
  }
  /* La base y la configuración del puente no se sirven al navegador. */
  if (archivo.indexOf(path.join(RAIZ_SITIO, 'puente', 'datos')) === 0 ||
      archivo === path.join(RAIZ_SITIO, 'puente', 'config.json')) {
    res.writeHead(403).end('Prohibido');
    return;
  }

  fs.readFile(archivo, function (err, datos) {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>404</h1><p>No se encontró ' + ruta + '</p>');
      return;
    }
    res.writeHead(200, {
      'Content-Type': TIPOS[path.extname(archivo).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(datos);
  });
}

/* =============================================================
   Despachador
   ============================================================= */

function partirUrl(url) {
  const crudo = String(url || '/');
  const corte = crudo.indexOf('?');
  const ruta = corte >= 0 ? crudo.slice(0, corte) : crudo;
  const query = corte >= 0 ? crudo.slice(corte + 1) : '';

  const params = {};
  query.split('&').forEach(function (par) {
    if (!par) return;
    const igual = par.indexOf('=');
    const llave = igual >= 0 ? par.slice(0, igual) : par;
    const valor = igual >= 0 ? par.slice(igual + 1) : '';
    try {
      params[decodeURIComponent(llave)] = decodeURIComponent(valor.replace(/\+/g, ' '));
    } catch (e) {
      params[llave] = valor;
    }
  });

  let limpia = ruta;
  try { limpia = decodeURIComponent(ruta); } catch (e) { /* se deja como vino */ }
  return { ruta: limpia, params: params };
}

/**
 * @param {Boolean} soloReceptor true en el servidor del puerto 80,
 *   que no sirve el sitio: ahí todo POST es del lector.
 */
function crearServidor(soloReceptor) {
  return http.createServer(function (req, res) {
    const { ruta, params } = partirUrl(req.url);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS'
      });
      res.end();
      return;
    }

    if (ruta.indexOf('/api/') === 0) {
      atenderApi(req, res, ruta, params).catch(function (e) {
        console.log('  ⚠  Error en ' + ruta + ':', e.message);
        json(res, { ok: false, error: e.message }, 500);
      });
      return;
    }

    /* Todo POST que no sea de la API se trata como evento del lector.
       Así da igual la ruta que traiga configurada ('/', '/evento', etc). */
    if (req.method === 'POST') {
      recibirDelLector(req, res, ruta).catch(function (e) {
        console.log('  ⚠  Error recibiendo evento:', e.message);
        res.writeHead(200).end('OK');
      });
      return;
    }

    if (soloReceptor) {
      /* Algunos modelos prueban la conexión con un GET antes de empujar. */
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Puente Gorilas escuchando');
      return;
    }

    servirSitio(req, res, ruta);
  });
}

/* =============================================================
   Arranque
   ============================================================= */

function ipsLocales() {
  const salida = [];
  const interfaces = os.networkInterfaces();
  for (const nombre in interfaces) {
    if (!Object.prototype.hasOwnProperty.call(interfaces, nombre)) continue;
    (interfaces[nombre] || []).forEach(function (dir) {
      if (dir.family === 'IPv4' && !dir.internal) salida.push(dir.address);
    });
  }
  return salida;
}

function arrancar() {
  const archivoBase = base.abrir(config.archivoBase);

  console.log('');
  console.log('  PUENTE GORILAS — lector de acceso  ->  sitio');
  console.log('  ============================================');
  console.log('  Base de datos:  ' + archivoBase);

  /* 1. Servidor del sitio + API */
  crearServidor(false).listen(config.puertoSitio, function () {
    console.log('  Sitio:          http://localhost:' + config.puertoSitio);
  }).on('error', function (e) {
    console.log('  ✗ No se pudo abrir el puerto ' + config.puertoSitio + ': ' + e.code);
    console.log('    Cambia "puertoSitio" en puente/config.json y vuelve a intentar.');
    process.exit(1);
  });

  /* 2. Receptor en el puerto que el lector tiene configurado */
  if (Number(config.puertoReceptor) !== Number(config.puertoSitio)) {
    crearServidor(true).listen(config.puertoReceptor, function () {
      estado.receptorEnPuerto = config.puertoReceptor;
      console.log('  Receptor:       puerto ' + config.puertoReceptor + ' de esta computadora');
      console.log('');
      console.log('  En el lector, el destino del envío de eventos debe ser:');
      ipsLocales().forEach(function (ip) {
        console.log('     IP ' + ip + '   ·   Puerto ' + config.puertoReceptor + '   ·   Ruta /');
      });
    }).on('error', function (e) {
      estado.receptorError = e.code;
      console.log('');
      console.log('  ⚠  El puerto ' + config.puertoReceptor + ' está ocupado (' + e.code + ').');
      console.log('     Otro programa lo tiene tomado. Dos salidas:');
      console.log('       a) Cierra ese programa (suele ser IIS o Skype).');
      console.log('       b) Pon otro puerto en puente/config.json ("puertoReceptor": 8080)');
      console.log('          y cámbialo también en el lector.');
      console.log('     Mientras tanto el sitio y la API siguen funcionando,');
      console.log('     y el puerto ' + config.puertoSitio + ' también acepta eventos.');
    });
  }

  console.log('');
  console.log('  Para detener: Ctrl + C');
  console.log('');
}

process.on('SIGINT', function () {
  console.log('\n  Cerrando el puente…');
  base.cerrar();
  process.exit(0);
});

arrancar();
