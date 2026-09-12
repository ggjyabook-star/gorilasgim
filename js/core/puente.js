/* =============================================================
   GORILAS GYM — Puente con el lector de acceso (AG.Puente)

   El sitio sigue siendo el mismo: rutinas, nutrición, pagos y todo
   lo demás no cambian. Esto solo agrega lo que el lector nos da y
   el sitio no tenía: las entradas reales, sin capturarlas a mano.

   Cómo trabaja:
     1. Pregunta si hay un puente corriendo (si no, todo sigue igual).
     2. Pide los accesos nuevos desde el último que ya trajo.
     3. Los que pertenecen a un socio vinculado se vuelven asistencias.

   Si el puente no está, ninguna pantalla se rompe: 'disponible()'
   devuelve false y el sitio se comporta exactamente como antes.
   ============================================================= */
window.AG = window.AG || {};
(function (AG) {
  'use strict';

  var Puente = {};

  /* =============================================================
     0. Constantes y estado
     ============================================================= */

  /* Cada cuánto se pregunta por accesos nuevos, con sesión abierta. */
  var MS_ENTRE_SINCRONIAS = 45000;

  /* Cuánto se espera al puente antes de darlo por ausente. */
  var MS_LIMITE = 6000;

  /* Si no hay puente, no se le pregunta a cada rato: se reintenta cada
     cinco minutos. Sin esto, un gimnasio que no usa lector acumularía
     errores 404 en la consola todo el día. El botón de la pantalla de
     Control de acceso salta esta espera. */
  var MS_REINTENTO = 300000;

  /* Dónde buscarlo: primero el mismo origen (node puente/puente.js sirve
     el sitio), luego el puerto de siempre por si el sitio se abrió como
     archivo suelto con doble clic.

     Desde una página https (el sitio publicado en internet) el navegador
     bloquea cualquier llamada a http://localhost, así que ahí ni se
     intenta: solo ensuciaría la consola cada vez. */
  function candidatos() {
    var lista = ['/api'];
    var seguro = false;
    try { seguro = window.location.protocol === 'https:'; } catch (e) { seguro = false; }
    if (!seguro) {
      lista.push('http://localhost:5173/api');
      lista.push('http://127.0.0.1:5173/api');
    }
    return lista;
  }

  var estado = {
    raiz: null,          // la base de la API que sí contestó
    probado: false,      // ya se hizo la primera búsqueda
    disponible: false,
    ultimoEstado: null,  // última respuesta de /api/estado
    sincronizando: false,
    reloj: null,
    ultimoError: '',
    ultimoIntento: 0     // cuándo se buscó el puente por última vez
  };

  var oyentes = { cambio: [], estado: [] };

  /* =============================================================
     1. Utilidades internas
     ============================================================= */

  function emitir(evento, datos) {
    var lista = oyentes[evento] || [];
    for (var i = 0; i < lista.length; i++) {
      try { lista[i](datos); } catch (e) { /* un oyente roto no tumba al resto */ }
    }
  }

  /** fetch con tiempo límite; nunca lanza, devuelve null si falla. */
  function pedir(url, opciones) {
    var o = opciones || {};

    return new Promise(function (resolver) {
      var terminado = false;
      var reloj = setTimeout(function () {
        if (terminado) return;
        terminado = true;
        resolver(null);
      }, o.limite || MS_LIMITE);

      var config = { method: o.metodo || 'GET', cache: 'no-store' };
      if (o.cuerpo !== undefined) {
        config.headers = { 'Content-Type': 'application/json' };
        config.body = JSON.stringify(o.cuerpo);
      }

      var promesa;
      try {
        promesa = window.fetch(url, config);
      } catch (e) {
        clearTimeout(reloj);
        resolver(null);
        return;
      }

      promesa.then(function (res) {
        return res.json();
      }).then(function (datos) {
        if (terminado) return;
        terminado = true;
        clearTimeout(reloj);
        resolver(datos);
      })['catch'](function () {
        if (terminado) return;
        terminado = true;
        clearTimeout(reloj);
        resolver(null);
      });
    });
  }

  /** Los ajustes del puente viven en settings, junto al resto. */
  function ajustes() {
    if (!AG.DB || !AG.DB.state) return { cursor: 0, activo: true };
    var s = AG.DB.state.settings = AG.DB.state.settings || {};
    if (!s.puente || typeof s.puente !== 'object') {
      s.puente = { cursor: 0, activo: true, ultimaSync: '', aplicados: 0 };
    }
    if (typeof s.puente.cursor !== 'number') s.puente.cursor = 0;
    if (typeof s.puente.activo !== 'boolean') s.puente.activo = true;
    return s.puente;
  }

  function hoy() {
    if (AG.Utils && typeof AG.Utils.hoy === 'function') {
      try { return AG.Utils.hoy(); } catch (e) { /* se usa el respaldo */ }
    }
    var d = new Date();
    function dos(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + dos(d.getMonth() + 1) + '-' + dos(d.getDate());
  }

  /** 'HH:MM' -> minutos, para comparar horas sin líos de formato. */
  function minutos(hhmm) {
    var m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ''));
    if (!m) return -1;
    return Number(m[1]) * 60 + Number(m[2]);
  }

  /* =============================================================
     2. Descubrimiento
     ============================================================= */

  /**
   * Busca el puente en los candidatos.
   * @param {Boolean} [forzar] saltarse la espera entre reintentos
   * @returns {Promise<Boolean>}
   */
  Puente.buscar = function (forzar) {
    if (estado.probado && estado.disponible) return Promise.resolve(true);

    /* Ya se buscó hace poco y no había: no se insiste todavía. */
    if (estado.probado && !forzar && (Date.now() - estado.ultimoIntento) < MS_REINTENTO) {
      return Promise.resolve(false);
    }
    estado.ultimoIntento = Date.now();

    var intentos = candidatos();

    function siguiente() {
      if (!intentos.length) {
        estado.probado = true;
        estado.disponible = false;
        estado.raiz = null;
        estado.ultimoEstado = null;
        emitir('estado', null);
        return Promise.resolve(false);
      }

      var raiz = intentos.shift();
      return pedir(raiz + '/estado', { limite: 2500 }).then(function (datos) {
        if (datos && datos.ok) {
          estado.raiz = raiz;
          estado.probado = true;
          estado.disponible = true;
          estado.ultimoEstado = datos;
          emitir('estado', datos);
          return true;
        }
        return siguiente();
      });
    }

    return siguiente();
  };

  Puente.disponible = function () { return estado.disponible; };
  Puente.raiz = function () { return estado.raiz; };
  Puente.ultimoEstado = function () { return estado.ultimoEstado; };
  Puente.ultimoError = function () { return estado.ultimoError; };

  /**
   * Vuelve a preguntar el estado al puente.
   * @param {Boolean} [forzar] buscarlo aunque se haya buscado hace poco
   */
  Puente.estado = function (forzar) {
    if (!estado.raiz) {
      return Puente.buscar(forzar).then(function (ok) {
        return ok ? estado.ultimoEstado : null;
      });
    }
    return pedir(estado.raiz + '/estado').then(function (datos) {
      if (datos && datos.ok) {
        estado.disponible = true;
        estado.ultimoEstado = datos;
      } else {
        /* El puente se cayó (lo apagaron, se cerró la ventana). Se olvida
           lo que sabíamos en vez de seguir enseñando números viejos como
           si estuviera vivo, y la próxima vez se vuelve a buscar. */
        estado.disponible = false;
        estado.ultimoEstado = null;
        estado.raiz = null;
        estado.probado = false;
      }
      emitir('estado', estado.ultimoEstado);
      return estado.ultimoEstado;
    });
  };

  /* =============================================================
     3. Convertir accesos en asistencias
     ============================================================= */

  /** ¿Ya se aplicó este acceso del lector? */
  function yaAplicado(socioId, fecha, idAcceso) {
    var previas = AG.DB.donde('asistencias', function (a) {
      return a.socioId === socioId && a.fecha === fecha;
    });
    for (var i = 0; i < previas.length; i++) {
      if (previas[i].refLector === idAcceso) return true;
      if (previas[i].refLectorSalida === idAcceso) return true;
    }
    return false;
  }

  /**
   * Aplica un acceso del lector a la colección de asistencias.
   * @returns {'entrada'|'salida'|'ignorado'|'sin_socio'|'rechazado'}
   */
  function aplicarAcceso(acceso) {
    if (!acceso || !acceso.socio_id) return 'sin_socio';
    if (Number(acceso.exito) === 0) return 'rechazado';

    var socio = AG.DB.usuario(acceso.socio_id);
    if (!socio || socio.rol !== 'socio') return 'sin_socio';

    var idAcceso = Number(acceso.id);
    if (yaAplicado(socio.id, acceso.fecha, idAcceso)) return 'ignorado';

    var previas = AG.DB.donde('asistencias', function (a) {
      return a.socioId === socio.id && a.fecha === acceso.fecha;
    });

    /* Hay una entrada sin salida: este toque cierra el día. */
    var abierta = null;
    for (var i = previas.length - 1; i >= 0; i--) {
      if (!previas[i].salida) { abierta = previas[i]; break; }
    }

    if (abierta) {
      /* Solo cuenta como salida si es posterior a la entrada; si el
         lector repite el toque en el mismo minuto, se deja pasar. */
      if (acceso.sentido === 'salida' || minutos(acceso.hora) > minutos(abierta.entrada)) {
        AG.DB.actualizar('asistencias', abierta.id, {
          salida: acceso.hora,
          refLectorSalida: idAcceso
        });
        return 'salida';
      }
      return 'ignorado';
    }

    /* Ya entró y salió hoy: no se duplica el día. */
    if (previas.length) return 'ignorado';

    /* Una salida suelta sin entrada previa no inventa un día. */
    if (acceso.sentido === 'salida') return 'ignorado';

    AG.DB.insertar('asistencias', {
      socioId: socio.id,
      fecha: acceso.fecha,
      entrada: acceso.hora,
      salida: null,
      origen: 'lector',
      metodo: acceso.metodo || '',
      refLector: idAcceso
    });
    return 'entrada';
  }

  /* =============================================================
     4. Sincronización
     ============================================================= */

  /**
   * Trae del puente los accesos nuevos y los aplica.
   * @param {{forzar:Boolean, desdeCero:Boolean}} [opts]
   * @returns {Promise<{ok:Boolean, entradas:Number, salidas:Number,
   *                    sinVincular:Number, ignorados:Number, error:String}>}
   */
  Puente.sincronizar = function (opts) {
    var o = opts || {};
    var vacio = { ok: false, entradas: 0, salidas: 0, sinVincular: 0, ignorados: 0, rechazados: 0, error: '' };

    if (estado.sincronizando) {
      vacio.error = 'ya_en_curso';
      return Promise.resolve(vacio);
    }

    var cfg = ajustes();
    if (!cfg.activo && !o.forzar) {
      vacio.error = 'apagado';
      return Promise.resolve(vacio);
    }

    estado.sincronizando = true;

    return Puente.buscar(o.forzar).then(function (hay) {
      if (!hay) {
        vacio.error = 'sin_puente';
        return vacio;
      }

      var desde = o.desdeCero ? 0 : (Number(cfg.cursor) || 0);

      return pedir(estado.raiz + '/accesos/nuevos?desdeId=' + desde + '&limite=500', { limite: 12000 })
        .then(function (datos) {
          if (!datos || !datos.ok) {
            vacio.error = 'sin_respuesta';
            estado.ultimoError = 'El puente no contestó la lista de accesos.';
            return vacio;
          }

          var res = { ok: true, entradas: 0, salidas: 0, sinVincular: 0, ignorados: 0, rechazados: 0, error: '' };
          var lista = datos.accesos || [];

          for (var i = 0; i < lista.length; i++) {
            var r = aplicarAcceso(lista[i]);
            if (r === 'entrada') res.entradas++;
            else if (r === 'salida') res.salidas++;
            else if (r === 'sin_socio') res.sinVincular++;
            else if (r === 'rechazado') res.rechazados++;
            else res.ignorados++;
          }

          cfg.cursor = Number(datos.cursor) || desde;
          cfg.ultimaSync = new Date().toISOString();
          cfg.aplicados = (Number(cfg.aplicados) || 0) + res.entradas + res.salidas;

          if (res.entradas || res.salidas) {
            AG.DB.guardar();
            AG.DB.emitir('cambio', { origen: 'puente' });
            emitir('cambio', res);
          } else {
            AG.DB.guardar();
          }

          estado.ultimoError = '';
          return res;
        });
    })['catch'](function (e) {
      vacio.error = e && e.message ? e.message : 'error';
      estado.ultimoError = vacio.error;
      return vacio;
    }).then(function (r) {
      estado.sincronizando = false;
      return r;
    });
  };

  /* =============================================================
     5. Consultas para las pantallas
     ============================================================= */

  Puente.personas = function () {
    if (!estado.raiz) return Promise.resolve([]);
    return pedir(estado.raiz + '/personas').then(function (d) {
      return (d && d.ok) ? (d.personas || []) : [];
    });
  };

  Puente.accesos = function (desde, hasta) {
    if (!estado.raiz) return Promise.resolve([]);
    var d = desde || hoy();
    var h = hasta || d;
    return pedir(estado.raiz + '/accesos?desde=' + d + '&hasta=' + h + '&limite=300')
      .then(function (r) { return (r && r.ok) ? (r.accesos || []) : []; });
  };

  Puente.vincular = function (personaId, socioId, socioNombre) {
    if (!estado.raiz) return Promise.resolve(false);
    return pedir(estado.raiz + '/vinculos', {
      metodo: 'POST',
      cuerpo: { personaId: personaId, socioId: socioId, socioNombre: socioNombre || '' }
    }).then(function (d) { return !!(d && d.ok); });
  };

  Puente.desvincular = function (personaId) {
    if (!estado.raiz) return Promise.resolve(false);
    return pedir(estado.raiz + '/vinculos?personaId=' + encodeURIComponent(personaId), { metodo: 'DELETE' })
      .then(function (d) { return !!(d && d.ok); });
  };

  Puente.crudos = function (limite) {
    if (!estado.raiz) return Promise.resolve([]);
    return pedir(estado.raiz + '/crudos?limite=' + (limite || 20))
      .then(function (d) { return (d && d.ok) ? (d.eventos || []) : []; });
  };

  Puente.buscarLector = function () {
    if (!estado.raiz) return Promise.resolve(null);
    return pedir(estado.raiz + '/lector/buscar', { limite: 120000 });
  };

  Puente.guardarLector = function (datos) {
    if (!estado.raiz) return Promise.resolve(null);
    return pedir(estado.raiz + '/lector/config', { metodo: 'POST', cuerpo: datos });
  };

  Puente.probarLector = function () {
    if (!estado.raiz) return Promise.resolve(null);
    return pedir(estado.raiz + '/lector/probar', { limite: 20000 });
  };

  Puente.importarPersonas = function () {
    if (!estado.raiz) return Promise.resolve(null);
    return pedir(estado.raiz + '/lector/personas', { metodo: 'POST', limite: 30000 });
  };

  Puente.importarRegistros = function (desde, hasta) {
    if (!estado.raiz) return Promise.resolve(null);
    return pedir(estado.raiz + '/lector/registros?desde=' + desde + '&hasta=' + hasta,
      { metodo: 'POST', limite: 60000 });
  };

  /* ---- Base de datos de Smart PSS Lite ---- */

  Puente.explorarSmartPss = function (ruta) {
    if (!estado.raiz) return Promise.resolve(null);
    var url = estado.raiz + '/smartpss/explorar';
    if (ruta) url += '?ruta=' + encodeURIComponent(ruta);
    return pedir(url, { limite: 20000 });
  };

  Puente.importarSmartPss = function (ruta) {
    if (!estado.raiz) return Promise.resolve(null);
    return pedir(estado.raiz + '/smartpss/importar', {
      metodo: 'POST',
      cuerpo: { ruta: ruta || '' },
      limite: 120000
    });
  };

  /* =============================================================
     6. Encendido automático
     ============================================================= */

  Puente.on = function (evento, fn) {
    if (!oyentes[evento]) oyentes[evento] = [];
    if (typeof fn === 'function') oyentes[evento].push(fn);
  };

  Puente.ajustes = ajustes;

  /** Deja el reloj andando: sincroniza ahora y luego cada 45 segundos. */
  Puente.iniciar = function () {
    if (estado.reloj) return;

    Puente.sincronizar();
    estado.reloj = setInterval(function () {
      if (!document.hidden) Puente.sincronizar();
    }, MS_ENTRE_SINCRONIAS);
  };

  Puente.detener = function () {
    if (!estado.reloj) return;
    clearInterval(estado.reloj);
    estado.reloj = null;
  };

  AG.Puente = Puente;

})(window.AG);
