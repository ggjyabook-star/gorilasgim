/* =============================================================
   PUENTE GORILAS — Interpretación de lo que manda el lector

   El lector (Dahua) empuja sus eventos por HTTP. El formato exacto
   cambia de modelo a modelo: unos mandan JSON puro, otros multipart
   con una parte JSON y la foto en otra, otros x-www-form-urlencoded.

   Por eso aquí no se asume una forma fija: se busca el JSON donde
   esté y luego se cosechan los campos por sus nombres conocidos,
   sin importar a qué profundidad vengan.

   Todo lo que no se entienda se guarda crudo y se puede ver en la
   pantalla de diagnóstico. Nunca se pierde un evento.
   ============================================================= */
'use strict';

const { partesDe } = require('./base');

/* =============================================================
   1. Sacar objetos JSON de lo que sea que haya llegado
   ============================================================= */

/** Extrae el boundary de un Content-Type multipart. */
function boundaryDe(tipoContenido) {
  const m = /boundary="?([^";]+)"?/i.exec(String(tipoContenido || ''));
  return m ? m[1] : '';
}

/**
 * Recorre el texto y devuelve cada bloque {...} balanceado que sea JSON válido.
 * Sirve igual para multipart, para JSON pegado a basura binaria y para JSON solo.
 */
function jsonSueltos(texto) {
  const encontrados = [];
  const s = String(texto || '');
  let i = 0;

  while (i < s.length) {
    const inicio = s.indexOf('{', i);
    if (inicio < 0) break;

    let nivel = 0;
    let enTexto = false;
    let escapado = false;
    let fin = -1;

    for (let j = inicio; j < s.length; j++) {
      const c = s[j];

      if (enTexto) {
        if (escapado) { escapado = false; continue; }
        if (c === '\\') { escapado = true; continue; }
        if (c === '"') enTexto = false;
        continue;
      }
      if (c === '"') { enTexto = true; continue; }
      if (c === '{') nivel++;
      else if (c === '}') {
        nivel--;
        if (nivel === 0) { fin = j; break; }
      }
    }

    if (fin < 0) break;

    const trozo = s.slice(inicio, fin + 1);
    try {
      const obj = JSON.parse(trozo);
      if (obj && typeof obj === 'object') encontrados.push(obj);
    } catch (e) { /* no era JSON: se sigue buscando más adelante */ }

    i = fin + 1;
  }

  return encontrados;
}

/** Interpreta un cuerpo x-www-form-urlencoded como objeto plano. */
function deFormulario(texto) {
  const salida = {};
  String(texto || '').split('&').forEach(function (par) {
    if (!par) return;
    const corte = par.indexOf('=');
    const llave = corte >= 0 ? par.slice(0, corte) : par;
    const valor = corte >= 0 ? par.slice(corte + 1) : '';
    if (!llave) return;
    try {
      salida[decodeURIComponent(llave.replace(/\+/g, ' '))] =
        decodeURIComponent(valor.replace(/\+/g, ' '));
    } catch (e) {
      salida[llave] = valor;
    }
  });
  return Object.keys(salida).length ? salida : null;
}

/**
 * Devuelve todos los objetos aprovechables del cuerpo recibido.
 * @param {String} cuerpo texto del cuerpo (binario ya filtrado a latin1)
 * @param {String} tipoContenido cabecera Content-Type
 */
function objetosDe(cuerpo, tipoContenido) {
  const tipo = String(tipoContenido || '').toLowerCase();
  const texto = String(cuerpo || '');

  if (tipo.indexOf('x-www-form-urlencoded') >= 0 && texto.indexOf('{') < 0) {
    const form = deFormulario(texto);
    return form ? [form] : [];
  }

  /* multipart, json o mezcla: el buscador de bloques balanceados sirve para los tres */
  const encontrados = jsonSueltos(texto);
  if (encontrados.length) return encontrados;

  const form = deFormulario(texto);
  return form ? [form] : [];
}

/* =============================================================
   2. Cosechar campos sin saber la forma exacta
   ============================================================= */

/**
 * Busca en todo el árbol la primera llave que coincida (sin distinguir
 * mayúsculas) con alguno de los alias, y devuelve su valor simple.
 */
function cosechar(raiz, alias) {
  const buscados = alias.map(function (a) { return a.toLowerCase(); });
  const pendientes = [raiz];
  let vueltas = 0;

  while (pendientes.length && vueltas < 5000) {
    vueltas++;
    const nodo = pendientes.shift();
    if (!nodo || typeof nodo !== 'object') continue;

    for (const llave in nodo) {
      if (!Object.prototype.hasOwnProperty.call(nodo, llave)) continue;
      const valor = nodo[llave];

      if (valor !== null && typeof valor === 'object') {
        pendientes.push(valor);
        continue;
      }
      if (valor === null || valor === undefined || valor === '') continue;
      if (buscados.indexOf(llave.toLowerCase()) >= 0) return valor;
    }
  }
  return null;
}

/**
 * Como 'cosechar', pero respetando el orden de la lista: prueba alias
 * por alias y devuelve el primero que exista. Importa cuando un mismo
 * objeto trae varios campos parecidos y uno vale más que otro.
 */
function cosecharEnOrden(raiz, alias) {
  for (let i = 0; i < alias.length; i++) {
    const valor = cosechar(raiz, [alias[i]]);
    if (valor !== null) return valor;
  }
  return null;
}

/** ¿Aparece en el árbol alguno de estos textos como valor o llave? */
function mencionaCodigo(raiz, textos) {
  const crudo = JSON.stringify(raiz || {}).toLowerCase();
  return textos.some(function (t) { return crudo.indexOf(t.toLowerCase()) >= 0; });
}

/* =============================================================
   3. Normalizar a nuestro formato de acceso
   ============================================================= */

/* Cómo se identificó la persona. El número varía por modelo; se
   cubren los más comunes y lo demás queda como 'otro'. */
const METODOS = {
  0: 'pin', 1: 'tarjeta', 2: 'huella', 3: 'pin', 4: 'tarjeta',
  5: 'huella', 6: 'rostro', 8: 'rostro', 15: 'rostro', 16: 'huella',
  17: 'rostro', 20: 'rostro', 100: 'qr'
};

function metodoDe(raiz) {
  const texto = cosecharEnOrden(raiz, ['VerifyMethod', 'OpenMethod', 'UnlockType', 'AttendanceMethod']);
  if (typeof texto === 'string' && /[a-z]/i.test(texto)) {
    const t = texto.toLowerCase();
    if (t.indexOf('face') >= 0 || t.indexOf('rostro') >= 0) return 'rostro';
    if (t.indexOf('card') >= 0) return 'tarjeta';
    if (t.indexOf('finger') >= 0) return 'huella';
    if (t.indexOf('password') >= 0 || t.indexOf('pin') >= 0) return 'pin';
    if (t.indexOf('qr') >= 0) return 'qr';
  }

  const num = cosecharEnOrden(raiz, ['Method', 'VerifyMethod', 'OpenMethod']);
  const n = Number(num);
  if (num !== null && !isNaN(n) && METODOS[n]) return METODOS[n];

  if (mencionaCodigo(raiz, ['FaceRecognition', 'faceinfo'])) return 'rostro';
  return 'otro';
}

/**
 * Entrada o salida según lo que diga el lector; 'desconocido' si no lo dice.
 *
 * Ojo con 'Status': en estos equipos significa "acceso concedido" (1)
 * o "rechazado" (0), NO el sentido. Usarlo aquí haría que todo entrara
 * como salida. El sentido solo sale de los campos de dirección.
 *
 * Cuando el lector no lo dice —que es lo normal con un solo lector en
 * la puerta— se devuelve 'desconocido' y manda la regla del sitio:
 * el primer paso del día es entrada y el segundo, salida.
 */
function sentidoDe(raiz) {
  const valor = cosecharEnOrden(raiz, ['Direction', 'InOutType', 'AttendanceState', 'EntryType', 'Type']);
  const t = String(valor === null ? '' : valor).toLowerCase();

  if (t === 'entry' || t === 'in' || t === 'checkin' || t === 'entrada') return 'entrada';
  if (t === 'exit' || t === 'out' || t === 'checkout' || t === 'salida') return 'salida';

  /* Los numéricos solo valen si vinieron de un campo de dirección real. */
  const direccion = cosecharEnOrden(raiz, ['Direction', 'InOutType', 'AttendanceState']);
  if (direccion !== null) {
    const d = String(direccion);
    if (d === '0') return 'entrada';
    if (d === '1') return 'salida';
  }

  /* Instalaciones con dos lectores: el 2 suele ser el de salida. */
  const lectorId = cosechar(raiz, ['ReaderID']);
  if (lectorId !== null && String(lectorId) === '2') return 'salida';

  return 'desconocido';
}

/** Fecha y hora del evento: primero la del lector, si no la de llegada. */
function momentoDe(raiz) {
  const local = cosechar(raiz, ['LocalTime', 'CreateTime', 'Time', 'StartTime', 'DateTime']);

  if (typeof local === 'string' && /\d{4}-\d{2}-\d{2}/.test(local)) {
    const m = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(local);
    if (m) {
      return {
        fecha: m[1] + '-' + m[2] + '-' + m[3],
        hora: m[4] + ':' + m[5],
        segundos: m[4] + ':' + m[5] + ':' + (m[6] || '00')
      };
    }
  }

  const utc = Number(cosechar(raiz, ['UTC', 'Timestamp', 'utcTime']));
  if (!isNaN(utc) && utc > 946684800) {
    /* segundos o milisegundos, según la magnitud */
    return partesDe(new Date(utc < 1e11 ? utc * 1000 : utc));
  }

  return partesDe(new Date());
}

/** ¿El evento fue un acceso concedido o uno rechazado? */
function exitoDe(raiz) {
  const error = cosechar(raiz, ['ErrorCode', 'ResultCode']);
  if (error !== null && Number(error) > 0) return false;

  const estado = cosechar(raiz, ['Status', 'Result', 'AccessResult']);
  const t = String(estado === null ? '' : estado).toLowerCase();
  if (t === 'false' || t === 'failed' || t === 'deny' || t === 'denied') return false;

  if (mencionaCodigo(raiz, ['AccessControlNotOpen', 'IllegalAccess', 'BreakIn'])) return false;
  return true;
}

/* Códigos que sí son un paso de persona por el lector. */
const CODIGOS_ACCESO = [
  'AccessControl', 'AccessControlCardRec', 'FaceRecognition', 'NewFaceRecognition',
  'AttendanceRecord', 'CardSwipe', 'AccessSnap', 'Attendance'
];

/* Códigos de mantenimiento que no son accesos. */
const CODIGOS_LATIDO = ['KeepAlive', 'Heartbeat', 'keepalive'];

/**
 * Convierte un objeto recibido en cero o más accesos normalizados.
 * @returns {{tipo:'latido'|'acceso'|'desconocido', accesos:Array}}
 */
function interpretar(objeto) {
  if (!objeto || typeof objeto !== 'object') {
    return { tipo: 'desconocido', accesos: [] };
  }

  if (mencionaCodigo(objeto, CODIGOS_LATIDO)) {
    return { tipo: 'latido', accesos: [] };
  }

  /* Un mismo POST puede traer varios eventos en un arreglo. */
  const lote = [];
  const contenedor = objeto.Events || objeto.events || objeto.EventList || objeto.Records;
  if (Array.isArray(contenedor) && contenedor.length) {
    contenedor.forEach(function (e) { lote.push(e); });
  } else {
    lote.push(objeto);
  }

  const accesos = [];

  lote.forEach(function (evento) {
    const personaId = cosechar(evento, ['UserID', 'UserId', 'PersonID', 'EmployeeNo', 'UserNo', 'ID']);
    const tarjeta = cosechar(evento, ['CardNo', 'CardNumber', 'CardID']);
    const nombre = cosechar(evento, ['CardName', 'UserName', 'PersonName', 'Name']);

    /* Sin ninguna identidad no hay nada que registrar. */
    if (personaId === null && tarjeta === null && nombre === null) return;

    /* Si no menciona ningún código de acceso conocido, igual se registra
       cuando trae identidad: más vale un acceso de más en diagnóstico
       que perder la entrada de un socio. */
    const esAcceso = mencionaCodigo(evento, CODIGOS_ACCESO) ||
                     personaId !== null || tarjeta !== null;
    if (!esAcceso) return;

    const momento = momentoDe(evento);

    accesos.push({
      personaId: personaId === null ? null : String(personaId).trim(),
      tarjeta: tarjeta === null ? null : String(tarjeta).trim(),
      nombre: nombre === null ? null : String(nombre).trim(),
      fecha: momento.fecha,
      hora: momento.hora,
      segundos: momento.segundos,
      sentido: sentidoDe(evento),
      metodo: metodoDe(evento),
      exito: exitoDe(evento),
      puerta: (function () {
        const p = cosechar(evento, ['Door', 'DoorNo', 'ChannelID', 'Channel']);
        return p === null ? null : String(p);
      })(),
      origen: 'push'
    });
  });

  return {
    tipo: accesos.length ? 'acceso' : 'desconocido',
    accesos: accesos
  };
}

/**
 * Punto de entrada: de un cuerpo HTTP a la lista de accesos.
 *
 * Acepta Buffer o texto. Con Buffer se lee primero como UTF-8, que
 * es como el lector manda los nombres (si no, "Ramírez" llega roto).
 * Si por el binario de la foto el UTF-8 no da nada aprovechable, se
 * reintenta como latin1, que conserva byte a byte.
 *
 * @returns {{tipo:String, accesos:Array, objetos:Number}}
 */
function deCuerpo(cuerpo, tipoContenido) {
  let objetos = [];

  if (Buffer.isBuffer(cuerpo)) {
    objetos = objetosDe(cuerpo.toString('utf8'), tipoContenido);
    if (!objetos.length) objetos = objetosDe(cuerpo.toString('latin1'), tipoContenido);
  } else {
    objetos = objetosDe(cuerpo, tipoContenido);
  }

  if (!objetos.length) return { tipo: 'desconocido', accesos: [], objetos: 0 };

  let tipo = 'desconocido';
  const accesos = [];

  objetos.forEach(function (obj) {
    const r = interpretar(obj);
    if (r.tipo === 'acceso') { tipo = 'acceso'; r.accesos.forEach(function (a) { accesos.push(a); }); }
    else if (r.tipo === 'latido' && tipo === 'desconocido') tipo = 'latido';
  });

  return { tipo: tipo, accesos: accesos, objetos: objetos.length };
}

module.exports = { deCuerpo, interpretar, objetosDe, jsonSueltos, cosechar };
