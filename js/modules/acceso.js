/* =============================================================
   GORILAS GYM — AG.Mod.Acceso
   -------------------------------------------------------------
   Lo que el lector de rostro nos da y el sitio no tenía: las
   entradas reales del gimnasio, sin capturarlas a mano.

   Esta pantalla no toca Smart PSS Lite ni le quita nada: los dos
   pueden trabajar al mismo tiempo con el mismo lector.

   Ruta: 'director/acceso'  ·  Menú: Operación › Control de acceso

   Cuatro pestañas:
     Estado       ¿está conectado el puente? ¿llega algo?
     Hoy          los accesos del día tal como los mandó el lector
     Personas     vincular cada persona del lector con su socio
     Diagnóstico  lo que llegó tal cual, para cuando algo no cuadre

   Si el puente no está corriendo, la pantalla lo dice con todas
   sus letras y explica cómo prenderlo. Nada más se rompe.
   ============================================================= */
window.AG = window.AG || {};
(function (AG) {
  'use strict';

  AG.Mod = AG.Mod || {};

  var U = AG.Utils;
  var Icons = AG.Icons;
  var DB = AG.DB;

  /* =============================================================
     0. Estado vivo de la pantalla
     ============================================================= */

  var estado = {
    pestana: 'estado',
    datos: null,        // última respuesta de /api/estado
    accesos: [],
    personas: [],
    crudos: [],
    cargando: false,
    busquedaPersona: ''
  };

  /* =============================================================
     1. Ayudantes
     ============================================================= */

  function esc(v) { return U.esc(v); }

  function icono(nombre, tam) {
    try { return Icons.get(nombre, tam || 16); } catch (e) { return ''; }
  }

  function toast(mensaje, tipo) { U.toast(mensaje, tipo || 'info'); }

  function P() { return AG.Puente; }

  function kpiHTML(nombreIcono, valor, etiqueta, variante) {
    return '<div class="kpi' + (variante ? ' ' + variante : '') + '">' +
      '<div class="kpi-icono">' + icono(nombreIcono, 22) + '</div>' +
      '<div class="kpi-datos"><div class="kpi-val">' + esc(valor) + '</div>' +
      '<div class="kpi-label">' + esc(etiqueta) + '</div></div></div>';
  }

  function vacio(iconoNombre, texto, extra) {
    return '<div class="empty"><div class="empty-icono">' + icono(iconoNombre, 32) + '</div>' +
      '<p class="empty-texto">' + esc(texto) + '</p>' + (extra || '') + '</div>';
  }

  /* Cómo se identificó la persona, en palabras. */
  var METODOS = {
    rostro: 'Rostro', tarjeta: 'Tarjeta', huella: 'Huella',
    pin: 'PIN', qr: 'Código QR', otro: 'Otro'
  };

  function etiquetaMetodo(m) { return METODOS[m] || 'Otro'; }

  function etiquetaSentido(s) {
    if (s === 'entrada') return 'Entrada';
    if (s === 'salida') return 'Salida';
    return 'Paso';
  }

  /* =============================================================
     2. Pestaña: Estado
     ============================================================= */

  function htmlSinPuente() {
    return '<div class="card"><div class="card-body">' +
      vacio('alerta', 'El puente no está corriendo en esta computadora.') +
      '<div class="mt">' +
        '<p class="mini muted mb">El puente es el programa que escucha al lector. ' +
        'Mientras no esté prendido, el sitio funciona igual que siempre, pero las ' +
        'entradas hay que registrarlas a mano en Asistencia.</p>' +
        '<p class="mini mb"><b>Para prenderlo:</b> doble clic en ' +
        '<code>ABRIR-CON-LECTOR.bat</code>, o desde la terminal:</p>' +
        '<pre class="code-block">node puente/puente.js</pre>' +
        '<button type="button" class="btn btn-outline btn-sm mt" data-reintentar>' +
          icono('historial', 15) + ' Volver a buscar el puente</button>' +
      '</div>' +
    '</div></div>';
  }

  function htmlEstado() {
    var d = estado.datos;
    if (!d) return htmlSinPuente();

    var p = d.puente || {};
    var l = d.lector || {};
    var c = d.conteos || {};
    var ips = p.ipsDeEstaPc || [];

    var recibiendo = p.eventosRecibidos > 0;
    var ultimo = d.ultimoAcceso;

    var html = '<div class="grid g4 mb">' +
      kpiHTML('qr', String(c.accesosHoy || 0), 'Pasos por el lector hoy', c.accesosHoy ? 'kpi-ok' : '') +
      kpiHTML('personas', String(c.personas || 0), 'Personas que conoce el lector', '') +
      kpiHTML('alerta', String(c.sinVincular || 0), 'Sin vincular a un socio',
        c.sinVincular ? 'kpi-warn' : '') +
      kpiHTML('historial', String(c.accesos || 0), 'Accesos guardados', '') +
    '</div>';

    /* ---- Tarjeta del puente ---- */
    html += '<div class="card mb"><div class="card-head">' +
      '<div class="card-title">' + icono('rayo', 18) + '<span>El puente</span></div>' +
      '<span class="badge badge-ok">Conectado</span>' +
      '</div><div class="card-body"><div class="list">' +

      filaDato('Encendido desde', p.arrancadoEn || '—') +
      filaDato('Mensajes recibidos del lector', String(p.eventosRecibidos || 0),
        recibiendo ? '' : 'Todavía no llega nada. Revisa la configuración de abajo.') +
      filaDato('Último latido del lector', p.ultimoLatido || 'ninguno todavía') +
      filaDato('Último acceso registrado', p.ultimoEvento || 'ninguno todavía') +
    '</div></div></div>';

    /* ---- Qué poner en el lector ---- */
    html += '<div class="card mb"><div class="card-head">' +
      '<div class="card-title">' + icono('config', 18) + '<span>Qué configurar en el lector</span></div>' +
      '</div><div class="card-body">' +
      '<p class="mini muted mb">En la página del lector, en <b>Envío de eventos por HTTP</b> ' +
      '(la pantalla que dice “Modo de carga: HTTP”), el destino debe apuntar a esta computadora:</p>' +
      '<div class="list">' +
        filaDato('IP de esta computadora', ips.length ? ips.join('  ·  ') : 'no se pudo leer') +
        filaDato('Puerto', p.receptorEnPuerto ? String(p.receptorEnPuerto) :
          ('el ' + (p.receptorError ? 'puerto 80 está ocupado (' + p.receptorError + ')' : '80'))) +
        filaDato('Ruta', '/') +
        filaDato('Tipo de evento', 'Registros de desbloqueo') +
      '</div>';

    if (p.receptorError) {
      html += '<p class="mini txt-error mt">El puerto 80 está ocupado por otro programa. ' +
        'Cambia "puertoReceptor" en puente/config.json (por ejemplo a 8080) y pon ese mismo ' +
        'puerto en el lector.</p>';
    }
    html += '</div></div>';

    /* ---- Último acceso ---- */
    if (ultimo) {
      html += '<div class="card mb"><div class="card-head">' +
        '<div class="card-title">' + icono('reloj', 18) + '<span>Lo último que pasó</span></div>' +
        '</div><div class="card-body"><div class="list">' + filaAcceso(ultimo) + '</div></div></div>';
    }

    /* ---- Importar desde la base de Smart PSS Lite ---- */
    html += '<div class="card mb"><div class="card-head">' +
      '<div class="card-title">' + icono('importar', 18) + '<span>Traer todo desde Smart PSS Lite</span></div>' +
      '</div><div class="card-body">' +
      '<p class="mini muted mb">Si el gimnasio ya tiene toda su gente cargada en Smart PSS Lite, ' +
      'esto lee su base de datos directamente y la trae de un jalón: personas, tarjetas y las ' +
      'entradas que ya tenga guardadas. <b>No le escribe nada</b> a Smart PSS: lee una copia. ' +
      'Tiene que correr en la computadora donde está instalado Smart PSS Lite.</p>' +
      '<div class="row wrap">' +
        '<button type="button" class="btn btn-outline btn-sm" data-explorar-spss>' +
          icono('buscar', 15) + ' Buscar su base de datos</button>' +
        '<button type="button" class="btn btn-primary btn-sm" data-importar-spss>' +
          icono('importar', 15) + ' Traer personas y accesos</button>' +
      '</div>' +
      '<div data-resultado-spss class="mt"></div>' +
    '</div></div>';

    /* ---- Datos del lector (segunda etapa) ---- */
    html += '<div class="card"><div class="card-head">' +
      '<div class="card-title">' + icono('candado', 18) + '<span>Conexión directa al lector</span></div>' +
      (l.configurado ? '<span class="badge badge-ok">' + esc(l.ip) + '</span>'
                     : '<span class="badge badge-muted">sin configurar</span>') +
      '</div><div class="card-body">' +
      '<p class="mini muted mb">Esto es opcional. Sin esto el puente ya recibe las entradas. ' +
      'Con la IP y la contraseña del lector, además se le pueden pedir sus personas y los ' +
      'registros de días pasados.</p>' +
      '<form data-form-lector autocomplete="off" novalidate><div class="row wrap">' +
        '<div class="field flex1 mb"><label class="label" for="ac-ip">IP del lector</label>' +
          '<input class="input" type="text" id="ac-ip" name="ip" placeholder="192.168.1.x" ' +
          'value="' + esc(l.ip || '') + '"></div>' +
        '<div class="field mb" style="max-width:110px"><label class="label" for="ac-puerto">Puerto</label>' +
          '<input class="input" type="number" id="ac-puerto" name="puerto" value="' + esc(l.puerto || 80) + '"></div>' +
        '<div class="field flex1 mb"><label class="label" for="ac-usuario">Usuario</label>' +
          '<input class="input" type="text" id="ac-usuario" name="usuario" value="' + esc(l.usuario || 'admin') + '"></div>' +
        '<div class="field flex1 mb"><label class="label" for="ac-pass">Contraseña</label>' +
          '<input class="input" type="password" id="ac-pass" name="contrasena" ' +
          'placeholder="' + (l.tieneContrasena ? 'guardada · escribe para cambiarla' : 'la del lector') + '"></div>' +
      '</div></form>' +
      '<div class="row wrap">' +
        '<button type="button" class="btn btn-primary btn-sm" data-guardar-lector>' +
          icono('check', 15) + ' Guardar y probar</button>' +
        '<button type="button" class="btn btn-outline btn-sm" data-buscar-lector>' +
          icono('buscar', 15) + ' Buscarlo en la red</button>' +
        (l.configurado ? '<button type="button" class="btn btn-outline btn-sm" data-importar-personas>' +
          icono('importar', 15) + ' Traer sus personas</button>' : '') +
      '</div>' +
      '<div data-resultado-lector class="mt"></div>' +
    '</div></div>';

    return html;
  }

  function filaDato(etiqueta, valor, ayuda) {
    return '<div class="list-item"><div class="list-item-main">' +
      '<b>' + esc(etiqueta) + '</b>' +
      (ayuda ? '<span class="mini muted">' + esc(ayuda) + '</span>' : '') +
      '</div><div class="list-item-side mini">' + esc(valor) + '</div></div>';
  }

  /* =============================================================
     3. Pestaña: Hoy
     ============================================================= */

  function nombreDeAcceso(a) {
    if (a.socio_id) {
      var socio = DB.usuario(a.socio_id);
      if (socio) return U.nombreCompleto(socio);
    }
    return a.nombre || ('Persona ' + (a.persona_id || a.tarjeta || '?'));
  }

  function filaAcceso(a) {
    var vinculado = !!a.socio_id;
    var rechazado = Number(a.exito) === 0;

    return '<div class="list-item">' +
      '<div class="list-item-main">' +
        '<b>' + esc(nombreDeAcceso(a)) + '</b>' +
        '<span class="mini muted">' +
          esc(etiquetaSentido(a.sentido)) + ' · ' + esc(etiquetaMetodo(a.metodo)) +
          (a.persona_id ? ' · ID ' + esc(a.persona_id) : '') +
          (vinculado ? '' : ' · sin vincular') +
        '</span>' +
      '</div>' +
      '<div class="list-item-side">' +
        '<span class="mini">' + esc((a.segundos || a.hora || '').slice(0, 5)) + '</span> ' +
        (rechazado ? '<span class="badge badge-danger">rechazado</span>'
          : vinculado ? '<span class="badge badge-ok">en el sitio</span>'
          : '<span class="badge badge-warn">pendiente</span>') +
      '</div>' +
    '</div>';
  }

  function htmlHoy() {
    if (!estado.datos) return htmlSinPuente();

    if (!estado.accesos.length) {
      return '<div class="card"><div class="card-body">' +
        vacio('reloj', 'Hoy todavía no pasa nadie por el lector.') +
        '</div></div>';
    }

    var html = '<div class="card"><div class="card-head">' +
      '<div class="card-title">' + icono('qr', 18) + '<span>Accesos de hoy</span></div>' +
      '<span class="badge badge-muted">' + estado.accesos.length + '</span>' +
      '</div><div class="card-body"><div class="list">';

    for (var i = 0; i < estado.accesos.length; i++) html += filaAcceso(estado.accesos[i]);
    return html + '</div></div></div>';
  }

  /* =============================================================
     4. Pestaña: Personas (vincular)
     ============================================================= */

  function opcionesSocios(seleccionado) {
    var socios = DB.socios().slice().sort(function (a, b) {
      return U.nombreCompleto(a).localeCompare(U.nombreCompleto(b));
    });
    var html = '<option value="">— sin vincular —</option>';
    for (var i = 0; i < socios.length; i++) {
      html += '<option value="' + esc(socios[i].id) + '"' +
        (socios[i].id === seleccionado ? ' selected' : '') + '>' +
        esc(U.nombreCompleto(socios[i])) + '</option>';
    }
    return html;
  }

  function htmlPersonas() {
    if (!estado.datos) return htmlSinPuente();

    var busqueda = String(estado.busquedaPersona || '').toLowerCase().trim();
    var lista = estado.personas.filter(function (p) {
      if (!busqueda) return true;
      return (String(p.nombre || '') + ' ' + String(p.persona_id || '') + ' ' +
        String(p.tarjeta || '')).toLowerCase().indexOf(busqueda) >= 0;
    });

    var html = '<div class="card mb"><div class="card-body">' +
      '<p class="mini muted mb">Cada persona que el lector conoce se conecta aquí con su socio ' +
      'del sitio. Una vez vinculada, sus entradas aparecen solas en Asistencia y en su ' +
      'progreso. Esto se hace una sola vez por socio.</p>' +
      '<input class="input" type="search" data-buscar-persona placeholder="Buscar por nombre, ID o tarjeta" ' +
      'value="' + esc(estado.busquedaPersona || '') + '">' +
    '</div></div>';

    if (!lista.length) {
      return html + '<div class="card"><div class="card-body">' +
        vacio('personas', estado.personas.length
          ? 'Ninguna persona coincide con esa búsqueda.'
          : 'El lector todavía no nos ha presentado a nadie. En cuanto alguien pase, aparece aquí.') +
      '</div></div>';
    }

    html += '<div class="card"><div class="card-head">' +
      '<div class="card-title">' + icono('personas', 18) + '<span>Personas del lector</span></div>' +
      '<span class="badge badge-muted">' + lista.length + '</span>' +
      '</div><div class="card-body"><div class="list">';

    for (var i = 0; i < lista.length; i++) {
      var p = lista[i];
      html += '<div class="list-item">' +
        '<div class="list-item-main">' +
          '<b>' + esc(p.nombre || ('Persona ' + p.persona_id)) + '</b>' +
          '<span class="mini muted">ID ' + esc(p.persona_id) +
            (p.tarjeta ? ' · tarjeta ' + esc(p.tarjeta) : '') +
            ' · ' + esc(p.veces || 0) + ' pasos' +
            (p.ultima_vez ? ' · visto ' + esc(String(p.ultima_vez).slice(0, 16)) : '') +
          '</span>' +
        '</div>' +
        '<div class="list-item-side">' +
          '<select class="select" data-vincular="' + esc(p.persona_id) + '">' +
            opcionesSocios(p.socio_id || '') +
          '</select>' +
        '</div>' +
      '</div>';
    }

    return html + '</div></div></div>';
  }

  /* =============================================================
     5. Pestaña: Diagnóstico
     ============================================================= */

  function htmlDiagnostico() {
    if (!estado.datos) return htmlSinPuente();

    var html = '<div class="card mb"><div class="card-body">' +
      '<p class="mini muted">Aquí se ve, sin adornos, lo último que mandó el lector. ' +
      'Sirve cuando algo no cuadra: si esta lista está vacía, el lector no está llegando ' +
      'a esta computadora y el problema es de red o de la configuración del equipo.</p>' +
      '<button type="button" class="btn btn-outline btn-sm mt" data-recargar-crudos>' +
        icono('historial', 15) + ' Actualizar</button>' +
    '</div></div>';

    if (!estado.crudos.length) {
      return html + '<div class="card"><div class="card-body">' +
        vacio('alerta', 'No ha llegado ni un mensaje del lector todavía.') +
      '</div></div>';
    }

    html += '<div class="card"><div class="card-body"><div class="list">';
    for (var i = 0; i < estado.crudos.length; i++) {
      var c = estado.crudos[i];
      html += '<div class="list-item"><div class="list-item-main">' +
        '<b>' + esc(c.recibido_en) + ' · ' + esc(c.ip || '?') + '</b>' +
        '<span class="mini muted">' + esc(c.tipo_contenido || 'sin tipo') + ' · ' +
          esc(c.bytes || 0) + ' bytes · ruta ' + esc(c.ruta || '/') + '</span>' +
        '<pre class="code-block mini">' + esc(String(c.cuerpo || '').slice(0, 600)) + '</pre>' +
        '</div><div class="list-item-side">' +
        (Number(c.interpretado) === 1
          ? '<span class="badge badge-ok">entendido</span>'
          : '<span class="badge badge-warn">no entendido</span>') +
        '</div></div>';
    }
    return html + '</div></div></div>';
  }

  /* =============================================================
     6. Armado de la pantalla
     ============================================================= */

  function htmlPestanas() {
    var c = (estado.datos && estado.datos.conteos) || {};

    function tab(clave, ic, texto, extra) {
      return '<button type="button" class="tab' + (estado.pestana === clave ? ' active' : '') +
        '" data-tab="' + clave + '">' + icono(ic, 16) + '<span>' + esc(texto) + '</span>' +
        (extra || '') + '</button>';
    }

    return '<div class="tabs">' +
      tab('estado', 'rayo', 'Estado') +
      tab('hoy', 'reloj', 'Hoy', estado.accesos.length
        ? '<span class="badge badge-ok">' + estado.accesos.length + '</span>' : '') +
      tab('personas', 'personas', 'Personas', c.sinVincular
        ? '<span class="badge badge-warn">' + c.sinVincular + '</span>' : '') +
      tab('diagnostico', 'info', 'Diagnóstico') +
    '</div>';
  }

  function htmlCuerpo() {
    if (estado.cargando) {
      return '<div class="card"><div class="card-body">' +
        '<p class="mini muted">Preguntándole al puente…</p></div></div>';
    }
    if (estado.pestana === 'hoy') return htmlHoy();
    if (estado.pestana === 'personas') return htmlPersonas();
    if (estado.pestana === 'diagnostico') return htmlDiagnostico();
    return htmlEstado();
  }

  function render() {
    var html = '<div class="page" data-acceso>' +
      '<div class="page-head"><div>' +
        '<h1 class="page-title">' + icono('qr', 24) + '<span>Control de acceso</span></h1>' +
        '<p class="page-sub">Las entradas que registra el lector de rostro, conectadas con los socios.</p>' +
      '</div><div class="page-acciones">' +
        '<button type="button" class="btn btn-primary" data-sincronizar>' +
          icono('historial', 16) + ' Sincronizar ahora</button>' +
      '</div></div>' +
      '<div data-tabs>' + htmlPestanas() + '</div>' +
      '<div data-cuerpo>' + htmlCuerpo() + '</div>' +
    '</div>';

    return { html: html, listo: function (root) { enganchar(root); cargar(root); } };
  }

  /* =============================================================
     7. Carga de datos y repintado
     ============================================================= */

  function repintar(raiz) {
    var tabs = raiz.querySelector('[data-tabs]');
    if (tabs) tabs.innerHTML = htmlPestanas();
    var cuerpo = raiz.querySelector('[data-cuerpo]');
    if (cuerpo) cuerpo.innerHTML = htmlCuerpo();
  }

  /**
   * @param {Element} root
   * @param {Boolean} [forzar] buscar el puente aunque se haya buscado hace poco.
   *   Se fuerza al abrir la pantalla y al darle al botón: quien entra aquí
   *   quiere saber cómo está el puente en este momento.
   */
  function cargar(root, forzar) {
    var raiz = root.querySelector('[data-acceso]') || root;
    if (!P()) { estado.datos = null; repintar(raiz); return; }

    estado.cargando = true;
    repintar(raiz);

    P().estado(forzar !== false).then(function (datos) {
      estado.datos = datos;
      if (!datos) { estado.cargando = false; repintar(raiz); return; }

      return Promise.all([
        P().accesos(U.hoy(), U.hoy()),
        P().personas(),
        P().crudos(15)
      ]).then(function (r) {
        estado.accesos = r[0] || [];
        estado.personas = r[1] || [];
        estado.crudos = r[2] || [];
      });
    })['catch'](function () { /* si algo falla se muestra lo que haya */ })
      .then(function () {
        estado.cargando = false;
        repintar(raiz);
      });
  }

  /* =============================================================
     8. Acciones
     ============================================================= */

  function sincronizar(raiz) {
    if (!P()) { toast('El puente no está disponible.', 'warn'); return; }

    P().sincronizar({ forzar: true }).then(function (r) {
      if (!r.ok) {
        if (r.error === 'sin_puente') toast('No encontré el puente corriendo.', 'error');
        else toast('No se pudo sincronizar.', 'error');
        cargar(raiz);
        return;
      }

      if (r.entradas || r.salidas) {
        toast('Listo: ' + r.entradas + ' entradas y ' + r.salidas + ' salidas al sitio.', 'ok');
      } else if (r.sinVincular) {
        toast(r.sinVincular + ' accesos esperan que vincules a su socio.', 'warn');
      } else {
        toast('Todo al día, no hay accesos nuevos.', 'info');
      }
      cargar(raiz);
    });
  }

  function guardarLector(raiz) {
    var form = raiz.querySelector('[data-form-lector]');
    if (!form) return;

    var datos = U.formToObject(form);
    var caja = raiz.querySelector('[data-resultado-lector]');

    if (!String(datos.ip || '').trim()) {
      toast('Falta la IP del lector.', 'warn');
      return;
    }
    if (caja) caja.innerHTML = '<p class="mini muted">Probando la conexión…</p>';

    var aEnviar = {
      ip: String(datos.ip).trim(),
      puerto: Number(datos.puerto) || 80,
      usuario: String(datos.usuario || 'admin').trim()
    };
    /* Vacía significa "deja la que ya estaba guardada". */
    if (String(datos.contrasena || '')) aEnviar.contrasena = String(datos.contrasena);

    P().guardarLector(aEnviar).then(function () {
      return P().probarLector();
    }).then(function (r) {
      if (!caja) return;
      if (r && r.ok) {
        var info = r.info || {};
        caja.innerHTML = '<p class="mini txt-ok">Conectado. ' +
          esc([info.modelo, info.version, info.serie].filter(Boolean).join(' · ')) + '</p>';
        toast('El lector contestó.', 'ok');
      } else {
        caja.innerHTML = '<p class="mini txt-error">' +
          esc((r && (r.pista || r.error)) || 'No se pudo conectar.') + '</p>';
        toast('No se pudo conectar con el lector.', 'error');
      }
    });
  }

  function buscarLector(raiz) {
    var caja = raiz.querySelector('[data-resultado-lector]');
    if (caja) {
      caja.innerHTML = '<p class="mini muted">Revisando la red… esto tarda hasta un minuto.</p>';
    }
    toast('Buscando el lector en la red…', 'info');

    P().buscarLector().then(function (r) {
      if (!caja) return;
      if (!r || !r.ok) {
        caja.innerHTML = '<p class="mini txt-error">No se pudo revisar la red.</p>';
        return;
      }
      if (!r.candidatos || !r.candidatos.length) {
        caja.innerHTML = '<p class="mini txt-error">No encontré ningún lector en la red ' +
          esc(r.red || '') + '. ¿Está esta computadora en la misma red que el lector?</p>';
        return;
      }

      var html = '<p class="mini txt-ok mb">Encontré ' + r.candidatos.length +
        (r.candidatos.length === 1 ? ' equipo:' : ' equipos:') + '</p><div class="list">';
      for (var i = 0; i < r.candidatos.length; i++) {
        var c = r.candidatos[i];
        html += '<div class="list-item"><div class="list-item-main">' +
          '<b>' + esc(c.ip) + '</b><span class="mini muted">' +
          esc(c.modeloProbable || c.realm || 'equipo compatible') +
          (c.puertoDahua ? ' · puerto Dahua abierto' : '') + '</span></div>' +
          '<div class="list-item-side">' +
          '<button type="button" class="btn btn-outline btn-sm" data-usar-ip="' + esc(c.ip) + '">Usar esta</button>' +
          '</div></div>';
      }
      caja.innerHTML = html + '</div>';
    });
  }

  function importarPersonas(raiz) {
    var caja = raiz.querySelector('[data-resultado-lector]');
    if (caja) caja.innerHTML = '<p class="mini muted">Pidiéndole sus personas al lector…</p>';

    P().importarPersonas().then(function (r) {
      if (r && r.ok) {
        toast('Llegaron ' + r.total + ' personas (' + r.nuevas + ' nuevas).', 'ok');
        cargar(raiz);
      } else {
        if (caja) {
          caja.innerHTML = '<p class="mini txt-error">' +
            esc((r && r.error) || 'El lector no soltó su lista de personas.') + '</p>';
        }
        toast('No se pudieron traer las personas.', 'error');
      }
    });
  }

  function vincular(raiz, personaId, socioId) {
    var socio = socioId ? DB.usuario(socioId) : null;

    var promesa = socioId
      ? P().vincular(personaId, socioId, socio ? U.nombreCompleto(socio) : '')
      : P().desvincular(personaId);

    promesa.then(function (ok) {
      if (!ok) { toast('No se pudo guardar el vínculo.', 'error'); return; }

      if (socioId) {
        toast('Listo: las entradas de ' + (socio ? U.nombreCompleto(socio) : 'esa persona') +
          ' ya se registran solas.', 'ok');
        /* Los accesos que estaban esperando vínculo se aplican desde cero. */
        P().sincronizar({ forzar: true, desdeCero: true }).then(function () { cargar(raiz); });
      } else {
        toast('Vínculo quitado.', 'info');
        cargar(raiz);
      }
    });
  }

  /* ---- Smart PSS Lite: leer su base directamente ---- */

  function pintarExploracionSpss(caja, r) {
    if (!caja) return;
    if (!r || !r.ok) {
      var msg = 'No pude revisar Smart PSS Lite.';
      if (r && r.error === 'no_encontrado') {
        msg = 'No encontré Smart PSS Lite instalado en esta computadora. ' +
          'El puente tiene que correr donde está instalado el programa.';
      } else if (r && r.error === 'sin_datos') {
        msg = 'Encontré Smart PSS Lite pero todavía sin datos. Seguramente no se ha ' +
          'abierto ni cargado gente en esta computadora.';
      }
      caja.innerHTML = '<p class="mini txt-error">' + esc(msg) + '</p>';
      return;
    }

    var html = '<p class="mini txt-ok mb">Smart PSS Lite en: <b>' + esc(r.instalacion || '') + '</b></p>';
    if (!r.archivos || !r.archivos.length) {
      caja.innerHTML = html + '<p class="mini muted">No hay bases de datos todavía.</p>';
      return;
    }

    html += '<div class="list">';
    for (var i = 0; i < r.archivos.length; i++) {
      var a = r.archivos[i];
      var insignia = a.estado === 'plano' ? '<span class="badge badge-ok">se puede leer</span>'
        : a.estado === 'cifrado' ? '<span class="badge badge-warn">cifrada</span>'
        : a.estado === 'vacio' ? '<span class="badge badge-muted">vacía</span>'
        : '<span class="badge badge-muted">' + esc(a.estado) + '</span>';
      html += '<div class="list-item"><div class="list-item-main">' +
        '<b>' + esc(a.que || a.nombre) + '</b>' +
        '<span class="mini muted">' + esc(a.nombre) + ' · ' + esc(Math.round((a.bytes || 0) / 1024)) + ' KB</span>' +
        '</div><div class="list-item-side">' + insignia + '</div></div>';
    }
    caja.innerHTML = html + '</div>';
  }

  function explorarSpss(raiz) {
    var caja = raiz.querySelector('[data-resultado-spss]');
    if (caja) caja.innerHTML = '<p class="mini muted">Buscando la base de Smart PSS Lite…</p>';
    P().explorarSmartPss().then(function (r) { pintarExploracionSpss(caja, r); });
  }

  function importarSpss(raiz) {
    var caja = raiz.querySelector('[data-resultado-spss]');
    if (caja) caja.innerHTML = '<p class="mini muted">Leyendo la base de Smart PSS Lite… (no se le escribe nada)</p>';

    P().importarSmartPss().then(function (r) {
      if (!r || !r.ok) {
        pintarExploracionSpss(caja, r);
        toast('No se pudo traer nada de Smart PSS Lite.', 'error');
        return;
      }

      var s = r.resumen || {};
      var html = '<p class="mini txt-ok mb">Leído de <b>' + esc(r.instalacion || '') + '</b></p><div class="list">';
      (r.detalle || []).forEach(function (d) {
        var insignia = d.estado === 'cifrado' ? '<span class="badge badge-warn">cifrada</span>'
          : d.estado === 'plano' ? '<span class="badge badge-ok">leída</span>'
          : '<span class="badge badge-muted">' + esc(d.estado) + '</span>';
        html += '<div class="list-item"><div class="list-item-main">' +
          '<b>' + esc(d.que || d.archivo) + '</b>' +
          '<span class="mini muted">' +
            (d.personas ? d.personas + ' personas · ' : '') +
            (d.accesos ? d.accesos + ' accesos · ' : '') +
            esc(d.nota || '') +
          '</span></div><div class="list-item-side">' + insignia + '</div></div>';
      });
      html += '</div>';

      if (s.basesCifradas) {
        html += '<p class="mini txt-error mt">' + s.basesCifradas + ' base(s) están cifradas por Smart PSS ' +
          'y no se pueden leer sin su llave. Para esos datos usa la conexión directa al lector, de abajo.</p>';
      }
      if (caja) caja.innerHTML = html;

      toast('Smart PSS: ' + (s.personasNuevas || 0) + ' personas y ' +
        (s.accesosNuevos || 0) + ' accesos nuevos.', s.personasNuevas || s.accesosNuevos ? 'ok' : 'info');

      /* Los accesos recién traídos que ya tengan socio vinculado se
         convierten en asistencias en el acto. */
      P().sincronizar({ forzar: true, desdeCero: true }).then(function () { cargar(raiz); });
    });
  }

  function enganchar(root) {
    var raiz = root.querySelector('[data-acceso]');
    if (!raiz || raiz.__accesoEnganchado) return;
    raiz.__accesoEnganchado = true;

    U.delegar(raiz, 'click', '[data-explorar-spss]', function (e) {
      e.preventDefault();
      explorarSpss(raiz);
    });

    U.delegar(raiz, 'click', '[data-importar-spss]', function (e) {
      e.preventDefault();
      importarSpss(raiz);
    });

    U.delegar(raiz, 'click', '[data-tab]', function (e, el) {
      e.preventDefault();
      estado.pestana = el.getAttribute('data-tab') || 'estado';
      repintar(raiz);
    });

    U.delegar(raiz, 'click', '[data-sincronizar]', function (e) {
      e.preventDefault();
      sincronizar(raiz);
    });

    U.delegar(raiz, 'click', '[data-reintentar]', function (e) {
      e.preventDefault();
      cargar(raiz);
    });

    U.delegar(raiz, 'click', '[data-guardar-lector]', function (e) {
      e.preventDefault();
      guardarLector(raiz);
    });

    U.delegar(raiz, 'click', '[data-buscar-lector]', function (e) {
      e.preventDefault();
      buscarLector(raiz);
    });

    U.delegar(raiz, 'click', '[data-importar-personas]', function (e) {
      e.preventDefault();
      importarPersonas(raiz);
    });

    U.delegar(raiz, 'click', '[data-usar-ip]', function (e, el) {
      e.preventDefault();
      var campo = raiz.querySelector('#ac-ip');
      if (campo) campo.value = el.getAttribute('data-usar-ip') || '';
      toast('IP puesta. Escribe la contraseña del lector y guarda.', 'info');
    });

    U.delegar(raiz, 'click', '[data-recargar-crudos]', function (e) {
      e.preventDefault();
      if (!P()) return;
      P().crudos(15).then(function (lista) {
        estado.crudos = lista || [];
        repintar(raiz);
      });
    });

    U.delegar(raiz, 'change', '[data-vincular]', function (e, el) {
      vincular(raiz, el.getAttribute('data-vincular'), el.value || '');
    });

    var buscarConRetraso = U.debounce(function () { repintar(raiz); }, 220);
    U.delegar(raiz, 'input', '[data-buscar-persona]', function (e, el) {
      estado.busquedaPersona = el.value || '';
      buscarConRetraso();
    });
  }

  /* =============================================================
     9. Exposición y registro de ruta
     ============================================================= */

  AG.Mod.Acceso = {
    render: render,
    sincronizar: function () { return P() ? P().sincronizar({ forzar: true }) : Promise.resolve(null); }
  };

  AG.Router.registrar({
    path: 'director/acceso',
    roles: ['director'],
    titulo: 'Control de acceso',
    nav: { etiqueta: 'Control de acceso', icono: 'qr', grupo: 'Operación', orden: 4 },
    render: render
  });

})(window.AG);
