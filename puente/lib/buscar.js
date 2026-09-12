/* =============================================================
   PUENTE GORILAS — Buscador del lector en la red

   Recorre la red local de esta computadora y reporta qué equipos
   parecen un lector Dahua. Sirve cuando nadie recuerda la IP.

   Dos señales:
     · puerto 37777 abierto      -> puerto privado de Dahua, señal fuerte
     · /cgi-bin pide Digest      -> API CGI viva, y el 'realm' suele traer
                                     el modelo ("Login to ASI7213Y")

   Solo mira la propia red local de esta máquina. No toca nada.
   ============================================================= */
'use strict';

const net = require('net');
const http = require('http');
const os = require('os');

/** Redes IPv4 locales de esta computadora, como '192.168.1'. */
function redesLocales() {
  const redes = [];
  const interfaces = os.networkInterfaces();

  for (const nombre in interfaces) {
    if (!Object.prototype.hasOwnProperty.call(interfaces, nombre)) continue;
    (interfaces[nombre] || []).forEach(function (dir) {
      if (dir.family !== 'IPv4' || dir.internal) return;
      const partes = dir.address.split('.');
      if (partes.length !== 4) return;
      const base = partes[0] + '.' + partes[1] + '.' + partes[2];
      if (redes.indexOf(base) < 0) redes.push({ base: base, propia: dir.address, interfaz: nombre });
    });
  }
  return redes;
}

/** ¿Contesta ese puerto TCP? */
function puertoAbierto(ip, puerto, ms) {
  return new Promise(function (resolver) {
    const socket = new net.Socket();
    let resuelto = false;

    function terminar(valor) {
      if (resuelto) return;
      resuelto = true;
      socket.destroy();
      resolver(valor);
    }

    socket.setTimeout(ms || 700);
    socket.once('connect', function () { terminar(true); });
    socket.once('timeout', function () { terminar(false); });
    socket.once('error', function () { terminar(false); });
    socket.connect(puerto, ip);
  });
}

/** Pregunta al CGI sin credenciales: si pide Digest, es un equipo de estos. */
function retoCgi(ip, puerto, ms) {
  return new Promise(function (resolver) {
    const req = http.request({
      host: ip,
      port: puerto || 80,
      path: '/cgi-bin/magicBox.cgi?action=getDeviceType',
      method: 'GET'
    }, function (res) {
      res.resume();
      const auth = String(res.headers['www-authenticate'] || '');
      const realm = /realm="([^"]+)"/i.exec(auth);
      resolver({
        contesta: true,
        pideDigest: /digest/i.test(auth),
        realm: realm ? realm[1] : '',
        servidor: String(res.headers.server || ''),
        estado: res.statusCode
      });
    });

    req.setTimeout(ms || 1200, function () { req.destroy(); resolver({ contesta: false }); });
    req.on('error', function () { resolver({ contesta: false }); });
    req.end();
  });
}

/** Corre las tareas de a poco para no saturar la red ni el equipo. */
async function enTandas(lista, cuantosALaVez, tarea) {
  const salida = [];
  for (let i = 0; i < lista.length; i += cuantosALaVez) {
    const tanda = lista.slice(i, i + cuantosALaVez);
    const hechos = await Promise.all(tanda.map(tarea));
    hechos.forEach(function (h) { if (h) salida.push(h); });
  }
  return salida;
}

/**
 * Busca lectores en la red local.
 * @param {Object} opts { red:'192.168.1', puerto:80 }
 * @returns {{redes:Array, candidatos:Array}}
 */
async function buscar(opts) {
  const o = opts || {};
  const redes = redesLocales();
  const base = o.red || (redes[0] && redes[0].base);

  if (!base) return { redes: redes, candidatos: [], error: 'sin_red' };

  const ips = [];
  for (let n = 1; n <= 254; n++) ips.push(base + '.' + n);

  /* Primero el puerto privado de Dahua: es rápido y muy específico. */
  const conPuertoDahua = await enTandas(ips, 48, async function (ip) {
    const abierto = await puertoAbierto(ip, 37777, 600);
    return abierto ? ip : null;
  });

  /* Luego el CGI, en los que respondieron y en el resto por si cambiaron el puerto. */
  const aRevisar = conPuertoDahua.length ? conPuertoDahua : ips;
  const candidatos = await enTandas(aRevisar, 32, async function (ip) {
    const r = await retoCgi(ip, Number(o.puerto) || 80, 1200);
    if (!r.contesta) return null;

    const esLector = r.pideDigest || conPuertoDahua.indexOf(ip) >= 0;
    if (!esLector) return null;

    return {
      ip: ip,
      puerto: Number(o.puerto) || 80,
      puertoDahua: conPuertoDahua.indexOf(ip) >= 0,
      realm: r.realm,
      servidor: r.servidor,
      /* El realm de Dahua suele decir "Login to <modelo>" */
      modeloProbable: (/login to\s+(.+)$/i.exec(r.realm) || [])[1] || ''
    };
  });

  return { redes: redes, red: base, candidatos: candidatos };
}

module.exports = { buscar, redesLocales, puertoAbierto, retoCgi };
