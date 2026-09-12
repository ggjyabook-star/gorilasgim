/* =============================================================
   PUENTE GORILAS — Cliente del lector (Dahua)

   Habla con el equipo por su API HTTP (CGI) con autenticación
   Digest, que es la que usan estos lectores. Smart PSS Lite usa
   este mismo camino: los dos pueden estar conectados a la vez.

   Aquí SOLO se lee del lector. Escribir personas y permisos es la
   segunda etapa; las funciones de escritura están marcadas y no se
   usan desde ninguna pantalla todavía.
   ============================================================= */
'use strict';

const http = require('http');
const crypto = require('crypto');

const TIEMPO_LIMITE = 8000;

/* =============================================================
   1. Autenticación Digest
   ============================================================= */

function md5(texto) {
  return crypto.createHash('md5').update(texto, 'utf8').digest('hex');
}

/** Parte la cabecera WWW-Authenticate en sus campos. */
function partesDelReto(cabecera) {
  const campos = {};
  const texto = String(cabecera || '').replace(/^Digest\s+/i, '');
  const re = /(\w+)=("([^"]*)"|([^,]*))/g;
  let m;
  while ((m = re.exec(texto)) !== null) {
    campos[m[1].toLowerCase()] = m[3] !== undefined ? m[3] : (m[4] || '').trim();
  }
  return campos;
}

/** Arma la cabecera Authorization para la segunda llamada. */
function cabeceraDigest(reto, usuario, contrasena, metodo, uri) {
  const realm = reto.realm || '';
  const nonce = reto.nonce || '';
  const qop = (reto.qop || '').split(',')[0].trim();
  const nc = '00000001';
  const cnonce = crypto.randomBytes(8).toString('hex');

  let ha1 = md5(usuario + ':' + realm + ':' + contrasena);
  if ((reto.algorithm || '').toLowerCase() === 'md5-sess') {
    ha1 = md5(ha1 + ':' + nonce + ':' + cnonce);
  }
  const ha2 = md5(metodo + ':' + uri);

  const respuesta = qop
    ? md5(ha1 + ':' + nonce + ':' + nc + ':' + cnonce + ':' + qop + ':' + ha2)
    : md5(ha1 + ':' + nonce + ':' + ha2);

  let cabecera = 'Digest username="' + usuario + '", realm="' + realm + '"' +
    ', nonce="' + nonce + '", uri="' + uri + '", response="' + respuesta + '"';
  if (reto.opaque) cabecera += ', opaque="' + reto.opaque + '"';
  if (reto.algorithm) cabecera += ', algorithm=' + reto.algorithm;
  if (qop) cabecera += ', qop=' + qop + ', nc=' + nc + ', cnonce="' + cnonce + '"';

  return cabecera;
}

/* =============================================================
   2. Petición HTTP con reintento autenticado
   ============================================================= */

function peticion(opciones, cuerpo) {
  return new Promise(function (resolver) {
    const req = http.request(opciones, function (res) {
      const trozos = [];
      res.on('data', function (d) { trozos.push(d); });
      res.on('end', function () {
        resolver({
          estado: res.statusCode,
          cabeceras: res.headers,
          texto: Buffer.concat(trozos).toString('utf8')
        });
      });
    });

    req.setTimeout(TIEMPO_LIMITE, function () {
      req.destroy();
      resolver({ estado: 0, cabeceras: {}, texto: '', error: 'tiempo_agotado' });
    });

    req.on('error', function (e) {
      resolver({ estado: 0, cabeceras: {}, texto: '', error: e.code || e.message });
    });

    if (cuerpo) req.write(cuerpo);
    req.end();
  });
}

/**
 * Llama a una ruta CGI del lector resolviendo el Digest.
 * @param {Object} cfg { ip, puerto, usuario, contrasena }
 * @param {String} ruta ruta completa con query, ej '/cgi-bin/magicBox.cgi?action=getDeviceType'
 */
async function llamar(cfg, ruta, metodo, cuerpo) {
  const verbo = metodo || 'GET';
  const base = {
    host: cfg.ip,
    port: Number(cfg.puerto) || 80,
    path: ruta,
    method: verbo,
    headers: cuerpo ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(cuerpo) } : {}
  };

  const primera = await peticion(base, cuerpo);
  if (primera.error) return { ok: false, error: primera.error, estado: 0 };

  if (primera.estado !== 401) {
    return { ok: primera.estado >= 200 && primera.estado < 300, estado: primera.estado, texto: primera.texto };
  }

  const reto = partesDelReto(primera.cabeceras['www-authenticate']);
  if (!reto.nonce) return { ok: false, error: 'sin_reto_digest', estado: 401 };

  const segunda = await peticion(Object.assign({}, base, {
    headers: Object.assign({}, base.headers, {
      Authorization: cabeceraDigest(reto, cfg.usuario || '', cfg.contrasena || '', verbo, ruta)
    })
  }), cuerpo);

  if (segunda.error) return { ok: false, error: segunda.error, estado: 0 };
  if (segunda.estado === 401) return { ok: false, error: 'credenciales', estado: 401 };

  return {
    ok: segunda.estado >= 200 && segunda.estado < 300,
    estado: segunda.estado,
    texto: segunda.texto
  };
}

/* =============================================================
   3. Respuestas en formato clave=valor
   ============================================================= */

/**
 * El lector contesta en texto plano tipo:
 *   table.AccessControlCard[0].CardName=Juan
 * Esto lo vuelve un arreglo de objetos indexados.
 */
function filasDe(texto) {
  const filas = {};
  String(texto || '').split(/\r?\n/).forEach(function (linea) {
    const corte = linea.indexOf('=');
    if (corte < 0) return;
    const llave = linea.slice(0, corte).trim();
    const valor = linea.slice(corte + 1).trim();

    const m = /\[(\d+)\]\.?(.*)$/.exec(llave);
    if (!m) return;
    const indice = m[1];
    const campo = (m[2] || 'valor').replace(/^\./, '');
    if (!filas[indice]) filas[indice] = {};
    filas[indice][campo] = valor;
  });

  return Object.keys(filas)
    .sort(function (a, b) { return Number(a) - Number(b); })
    .map(function (k) { return filas[k]; });
}

/** Lee 'found=12' de la respuesta de recordFinder. */
function encontrados(texto) {
  const m = /found\s*=\s*(\d+)/i.exec(String(texto || ''));
  return m ? Number(m[1]) : 0;
}

/* =============================================================
   4. Operaciones de lectura
   ============================================================= */

/**
 * Prueba la conexión y devuelve lo que el lector diga de sí mismo.
 * Es lo primero que hay que correr cuando lleguen las credenciales.
 */
async function probar(cfg) {
  const tipo = await llamar(cfg, '/cgi-bin/magicBox.cgi?action=getDeviceType');

  if (!tipo.ok) {
    return {
      ok: false,
      error: tipo.error || ('HTTP ' + tipo.estado),
      pista: pistaDeError(tipo)
    };
  }

  const info = { modelo: (tipo.texto || '').split('=')[1] || '' };

  const version = await llamar(cfg, '/cgi-bin/magicBox.cgi?action=getSoftwareVersion');
  if (version.ok) {
    const m = /version=([^\r\n]+)/i.exec(version.texto || '');
    if (m) info.version = m[1].trim();
  }

  const serie = await llamar(cfg, '/cgi-bin/magicBox.cgi?action=getSerialNo');
  if (serie.ok) {
    const m = /sn=([^\r\n]+)/i.exec(serie.texto || '');
    if (m) info.serie = m[1].trim();
  }

  return { ok: true, info: info };
}

function pistaDeError(r) {
  if (r.error === 'credenciales') return 'El usuario o la contraseña del lector no son correctos.';
  if (r.error === 'tiempo_agotado') return 'El lector no contestó. ¿Está encendido y en la misma red que esta computadora?';
  if (r.error === 'ECONNREFUSED') return 'Esa IP contestó pero el puerto está cerrado. Revisa el puerto HTTP del lector.';
  if (r.error === 'EHOSTUNREACH' || r.error === 'ENETUNREACH') return 'Esa IP no existe en esta red.';
  if (r.estado === 404) return 'Contestó, pero no expone la API CGI. ¿Es el modelo correcto?';
  return 'No se pudo hablar con el lector.';
}

/**
 * Trae las personas dadas de alta en el lector (tarjetas).
 * @returns {{ok:Boolean, personas:Array}}
 */
async function personas(cfg, limite) {
  const tope = Math.min(Number(limite) || 500, 3000);

  /* Camino 1: búsqueda paginada (es el que traen la mayoría de los modelos). */
  const inicio = await llamar(cfg,
    '/cgi-bin/recordFinder.cgi?action=starFind&name=AccessControlCard&count=' + tope);

  if (inicio.ok) {
    const m = /token=(\d+)/i.exec(inicio.texto || '');
    if (m) {
      const token = m[1];
      const lote = await llamar(cfg,
        '/cgi-bin/recordFinder.cgi?action=doFind&token=' + token + '&count=' + tope);
      await llamar(cfg, '/cgi-bin/recordFinder.cgi?action=destroy&token=' + token);

      if (lote.ok) return { ok: true, personas: normalizarPersonas(filasDe(lote.texto)) };
    }
  }

  /* Camino 2: búsqueda directa. */
  const directo = await llamar(cfg, '/cgi-bin/recordFinder.cgi?action=find&name=AccessControlCard');
  if (directo.ok) return { ok: true, personas: normalizarPersonas(filasDe(directo.texto)) };

  return { ok: false, error: directo.error || ('HTTP ' + directo.estado), personas: [] };
}

function normalizarPersonas(filas) {
  return filas.map(function (f) {
    return {
      personaId: String(f.UserID || f.UserId || f.RecNo || '').trim(),
      nombre: String(f.CardName || f.UserName || '').trim(),
      tarjeta: String(f.CardNo || '').trim(),
      recno: String(f.RecNo || '').trim()
    };
  }).filter(function (p) { return p.personaId || p.tarjeta; });
}

/**
 * Trae los registros de acceso guardados en el lector entre dos fechas.
 * Sirve para recuperar lo de días en que el puente estuvo apagado.
 * @param {String} desde 'YYYY-MM-DD'
 * @param {String} hasta 'YYYY-MM-DD'
 */
async function registros(cfg, desde, hasta, limite) {
  const tope = Math.min(Number(limite) || 1000, 5000);
  const inicioTxt = encodeURIComponent(desde + ' 00:00:00');
  const finTxt = encodeURIComponent(hasta + ' 23:59:59');

  const inicio = await llamar(cfg,
    '/cgi-bin/recordFinder.cgi?action=starFind&name=AccessControlCardRec' +
    '&condition.StartTime=' + inicioTxt + '&condition.EndTime=' + finTxt);

  if (!inicio.ok) return { ok: false, error: inicio.error || ('HTTP ' + inicio.estado), registros: [] };

  const m = /token=(\d+)/i.exec(inicio.texto || '');
  if (!m) return { ok: false, error: 'sin_token', registros: [] };

  const token = m[1];
  const total = encontrados(inicio.texto);
  const salida = [];

  /* Se pide de 100 en 100 hasta agotar o llegar al tope. */
  for (let leidos = 0; leidos < Math.min(total || tope, tope); leidos += 100) {
    const lote = await llamar(cfg,
      '/cgi-bin/recordFinder.cgi?action=doFind&token=' + token + '&count=100');
    if (!lote.ok) break;
    const filas = filasDe(lote.texto);
    if (!filas.length) break;
    filas.forEach(function (f) { salida.push(f); });
  }

  await llamar(cfg, '/cgi-bin/recordFinder.cgi?action=destroy&token=' + token);

  return { ok: true, registros: salida };
}

/* =============================================================
   5. Escritura — segunda etapa, todavía sin usar
   -------------------------------------------------------------
   Queda escrito para cuando decidas dar de alta socios desde el
   sitio. Ninguna pantalla lo llama por ahora: mientras el lector
   mande y el sitio solo reciba, esto no se toca.
   ============================================================= */

/**
 * Da de alta una persona en el lector con su tarjeta, PIN y vigencia.
 * @param {Object} p { personaId, nombre, tarjeta, pin, desde, hasta, puertas }
 */
async function altaPersona(cfg, p) {
  const puertas = (p.puertas && p.puertas.length ? p.puertas : [0])
    .map(function (d, i) { return '&Doors[' + i + ']=' + d; }).join('');

  const ruta = '/cgi-bin/recordUpdater.cgi?action=insert&name=AccessControlCard' +
    '&CardName=' + encodeURIComponent(p.nombre || '') +
    '&CardNo=' + encodeURIComponent(p.tarjeta || '') +
    '&UserID=' + encodeURIComponent(p.personaId || '') +
    '&CardStatus=0&CardType=0' +
    (p.pin ? '&Password=' + encodeURIComponent(p.pin) : '') +
    '&ValidDateStart=' + encodeURIComponent((p.desde || '2020-01-01') + ' 00:00:00') +
    '&ValidDateEnd=' + encodeURIComponent((p.hasta || '2035-12-31') + ' 23:59:59') +
    puertas;

  const r = await llamar(cfg, ruta);
  return { ok: r.ok, respuesta: r.texto, error: r.error };
}

/** Baja de una persona por su número de registro en el lector. */
async function bajaPersona(cfg, recno) {
  const r = await llamar(cfg,
    '/cgi-bin/recordUpdater.cgi?action=remove&name=AccessControlCard&recno=' + encodeURIComponent(recno));
  return { ok: r.ok, respuesta: r.texto, error: r.error };
}

module.exports = {
  probar, personas, registros, llamar, filasDe,
  altaPersona, bajaPersona
};
