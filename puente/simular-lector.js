/* =============================================================
   PUENTE GORILAS — Simulador del lector

   Manda al puente los mismos eventos que mandaría el lector real,
   para poder probar toda la cadena sin tener el equipo enfrente.

   Uso:
     node puente/puente.js            (en una ventana, déjalo corriendo)
     node puente/simular-lector.js    (en otra ventana)

   Manda tres formas distintas de evento porque cada modelo de
   lector usa la suya: JSON puro, multipart con foto, y latido.
   ============================================================= */
'use strict';

const http = require('http');

const PUERTO = Number(process.argv[2]) || 5173;
const HOST = process.argv[3] || '127.0.0.1';

function dos(n) { return (n < 10 ? '0' : '') + n; }

function ahoraTexto() {
  const d = new Date();
  return d.getFullYear() + '-' + dos(d.getMonth() + 1) + '-' + dos(d.getDate()) + ' ' +
    dos(d.getHours()) + ':' + dos(d.getMinutes()) + ':' + dos(d.getSeconds());
}

function enviar(cuerpo, tipoContenido, etiqueta) {
  return new Promise(function (resolver) {
    const datos = Buffer.isBuffer(cuerpo) ? cuerpo : Buffer.from(cuerpo, 'utf8');

    const req = http.request({
      host: HOST,
      port: PUERTO,
      path: '/',
      method: 'POST',
      headers: { 'Content-Type': tipoContenido, 'Content-Length': datos.length }
    }, function (res) {
      const trozos = [];
      res.on('data', function (d) { trozos.push(d); });
      res.on('end', function () {
        console.log('  ' + etiqueta + '  ->  HTTP ' + res.statusCode + '  ' +
          Buffer.concat(trozos).toString('utf8').trim());
        resolver();
      });
    });

    req.on('error', function (e) {
      console.log('  ' + etiqueta + '  ->  ERROR ' + (e.code || e.message));
      console.log('     ¿Está corriendo el puente?  node puente/puente.js');
      resolver();
    });

    req.write(datos);
    req.end();
  });
}

/* ---------- 1. Evento de acceso en JSON (el formato más común) ---------- */
function eventoJson(userId, nombre, tarjeta, metodo, cuando) {
  const momento = cuando || ahoraTexto();
  return JSON.stringify({
    Events: [{
      Action: 'Pulse',
      Code: 'AccessControl',
      Index: 0,
      Data: {
        CardName: nombre,
        CardNo: tarjeta,
        UserID: String(userId),
        Door: 0,
        ReaderID: '1',
        ErrorCode: 0,
        Method: metodo,
        Status: 1,
        Type: 'Entry',
        LocalTime: momento,
        UTC: Math.floor(Date.now() / 1000)
      }
    }]
  });
}

/* ---------- 2. Evento multipart con foto (otros modelos) ---------- */
function eventoMultipart(userId, nombre, tarjeta) {
  const limite = '----DahuaBoundary7e3f';
  const json = JSON.stringify({
    Code: 'FaceRecognition',
    Action: 'Start',
    Data: {
      UserID: String(userId),
      CardName: nombre,
      CardNo: tarjeta,
      Method: 15,
      ErrorCode: 0,
      LocalTime: ahoraTexto()
    }
  });

  /* Una "foto" mínima: bytes binarios, como los que manda el equipo. */
  const foto = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0xFF, 0xD9]);

  return Buffer.concat([
    Buffer.from(
      '--' + limite + '\r\n' +
      'Content-Type: text/plain\r\n' +
      'Content-Disposition: form-data; name="Event"\r\n\r\n' +
      json + '\r\n' +
      '--' + limite + '\r\n' +
      'Content-Type: image/jpeg\r\n' +
      'Content-Disposition: form-data; name="Photo"; filename="rostro.jpg"\r\n\r\n', 'utf8'),
    foto,
    Buffer.from('\r\n--' + limite + '--\r\n', 'utf8')
  ]);
}

/* ---------- 3. Latido ---------- */
function latido() {
  return JSON.stringify({ Code: 'KeepAlive', Action: 'Pulse', Data: { Interval: 30 } });
}

async function correr() {
  console.log('');
  console.log('  Simulando el lector contra http://' + HOST + ':' + PUERTO);
  console.log('  --------------------------------------------------');

  await enviar(latido(), 'application/json', 'latido            ');

  /* Se guarda el momento exacto para poder repetir el MISMO evento al final. */
  const momentoAna = ahoraTexto();

  await enviar(eventoJson(1001, 'Ana Ramírez', '00123456', 15, momentoAna),
    'application/json', 'entrada por rostro');

  await enviar(eventoJson(1002, 'Luis Ortega', '00987654', 1),
    'application/json', 'entrada por tarjeta');

  const multi = eventoMultipart(1003, 'Sofía Beltrán', '00555111');
  await enviar(multi, 'multipart/form-data; boundary=----DahuaBoundary7e3f',
    'entrada multipart  ');

  /* El MISMO evento otra vez: no se debe duplicar. */
  await enviar(eventoJson(1001, 'Ana Ramírez', '00123456', 15, momentoAna),
    'application/json', 'repetido (no duplica)');

  console.log('');
  console.log('  Listo. Abre el sitio, entra como dirección y ve a');
  console.log('  Operación › Control de acceso para verlos.');
  console.log('');
}

correr();
