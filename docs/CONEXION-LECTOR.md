# Conexión con el lector de acceso (Dahua / Smart PSS Lite)

**Objetivo:** que cuando un socio pase por el lector de rostro del gimnasio,
su entrada aparezca sola en Gorilas Gym. Sin capturarla a mano y sin tocar
Smart PSS Lite.

---

## Regla de oro

**A Smart PSS Lite no se le toca nada.** Ni su base de datos, ni su
configuración, ni su licencia. Sigue trabajando exactamente igual que hoy.

Lo que hacemos es hablarle **al lector**, que es de quien Smart PSS Lite saca
sus datos. Los dos pueden estar conectados al mismo tiempo sin estorbarse:
el lector acepta varios clientes a la vez.

---

## Dos formas de traer los datos

Hay dos caminos, y se pueden usar los dos:

**1. Leer la base de datos de Smart PSS Lite (de un jalón).**
Smart PSS Lite guarda su gente y sus registros en archivos SQLite dentro de su
propia carpeta. El puente los **lee directamente** — copiándolos primero para
no tocar el original — y se trae de golpe todas las personas, tarjetas y las
entradas que ya tenga guardadas. Es lo mejor para el arranque: en un clic entra
todo lo que el gimnasio ya cargó.

> **Ojo 1:** tiene que correr en la computadora donde está instalado Smart PSS
> Lite. Los archivos están en `Data/System/Database/` dentro de su carpeta.
>
> **Ojo 2:** Smart PSS Lite puede **cifrar** algunas de esas bases. Si están
> cifradas, el puente lo detecta y lo avisa; esos datos se traen por el camino 2.

**2. Escuchar lo que el lector empuja (en vivo).**
El lector manda cada desbloqueo por HTTP en el momento. Eso **no pide usuario ni
contraseña** y mantiene el sitio al día minuto a minuto, sin depender de Smart
PSS. Es lo mejor para el día a día.

El plan natural: **camino 1 una vez** para cargar todo, y **camino 2 encendido
siempre** para lo nuevo.

> Smart PSS Lite es una app de escritorio: no tiene API ni servicio web, así que
> no se le puede "pedir" nada por fuera. Por eso se lee su base de datos
> directamente (camino 1) o se escucha al lector (camino 2), nunca a través del
> programa. En ningún caso se le escribe nada a Smart PSS.

---

## Las piezas

```
  Lector de rostro            PC del gimnasio                  Navegador
 ┌──────────────────┐      ┌────────────────────┐          ┌──────────────┐
 │ Dahua            │─HTTP▶│ puente/puente.js   │◀──────── │ Gorilas Gym  │
 │ 192.168.1.xxx    │ push │ escucha y guarda   │   /api   │ el sitio     │
 └──────────────────┘      │ en SQLite propio   │          └──────────────┘
                           │        ▲           │
                           │        │ lee copia │
                           │  ┌─────┴────────┐  │
                           │  │ Smart PSS DB │  │  ← se LEE, nunca se escribe
                           │  │ (ACS*.db)    │  │
                           └──┴──────────────┴──┘
```

1. **El puente** (`puente/puente.js`) hace dos cosas: escucha lo que el lector
   empuja **y** puede leer la base de datos de Smart PSS Lite cuando se le pide.
2. Guarda todo en su propio SQLite (`puente/datos/puente.db`), aparte de todo.
3. **El sitio** le pregunta al puente y convierte cada acceso en asistencia.
4. **Smart PSS Lite** sigue igual: de su base solo se lee una copia, jamás se
   escribe.

---

## Lo que hace falta para conectarlo · LISTA

### A. Del lector (se ven en su página web, o en Smart PSS Lite → Dispositivos)

| # | Dato | Dónde sale | ¿Obligatorio? |
|---|---|---|---|
| 1 | **IP del lector** (ej. `192.168.1.64`) | Smart PSS Lite → Dispositivos, columna IP | Solo para la etapa 2 |
| 2 | **Puerto HTTP** (casi siempre `80`) | Igual | Solo para la etapa 2 |
| 3 | **Usuario y contraseña** del lector | Los que se usaron para agregarlo a Smart PSS Lite | Solo para la etapa 2 |
| 4 | **Marca y modelo** (ej. Dahua ASI7213Y) | Etiqueta del equipo o su página web | Ayuda a afinar |

> **Ojo:** para que las entradas empiecen a llegar **no hace falta nada de
> esto**. El lector empuja sus eventos sin pedir usuario ni contraseña. Estos
> datos sirven para lo de la etapa 2 (pedirle su lista de personas y los
> registros de días pasados).

### B. De la computadora donde va a correr el puente

| # | Qué | Por qué |
|---|---|---|
| 5 | Que esté **en la misma red** que el lector (`192.168.1.x`) | Si están en redes distintas no se ven |
| 6 | Su **IP fija** (que no se la cambie el router) | El lector necesita saber a dónde mandar |
| 7 | **Node.js 22 o más nuevo** instalado | Es lo que corre el puente |
| 8 | El **puerto 80 libre** | Es donde escucha. Si está ocupado se usa otro |
| 9 | Que **quede prendida** mientras el gimnasio trabaja | Si está apagada no recibe nada |

Lo natural es que sea **la misma computadora donde está Smart PSS Lite**, porque
ya cumple 5 y 9. Pero puede ser cualquier otra de esa red.

### C. Un cambio en la configuración del lector

En la página web del lector, en la pantalla de **envío de eventos por HTTP**
(la que dice *Modo de carga: HTTP*, la de tu captura):

| Campo | Qué poner |
|---|---|
| Activar | **Encendido** |
| IP/Nombre de dominio | La IP de la computadora del puente |
| Puerto | `80` (o el que diga el puente al arrancar) |
| HTTPs | Apagado |
| Ruta | `/` |
| Latido | `30` |
| Tipo de evento | Registros de desbloqueo |

> Esa pantalla ya la tienes con `192.168.1.108`. Si el puente va a correr en esa
> misma computadora, **no hay que cambiar nada**: solo prender el interruptor
> de *Activar*, que en tu captura está apagado.

### D. De Smart PSS Lite

**Nada.** No se instala, no se configura, no se modifica.

---

## Pasos, en orden

1. Copiar la carpeta del sistema a la computadora del gimnasio.
2. Instalar Node.js (https://nodejs.org, la versión LTS).
3. Doble clic en **`ABRIR-CON-LECTOR.bat`**.
   Al arrancar, el puente imprime la IP y el puerto que hay que poner en el
   lector. Esa ventana **se queda abierta**.
4. Entrar al sitio como **Dirección → Operación → Control de acceso**.
   La pestaña *Estado* dice si el puente está vivo y qué configurar.
5. En la página del lector, poner lo de la tabla **C** y encender *Activar*.
6. **Traer todo lo que ya hay** (camino 1): en *Control de acceso → Estado →
   Traer todo desde Smart PSS Lite*, dar clic en **Traer personas y accesos**.
   Se lee la base de Smart PSS y entra toda la gente de golpe.
7. **Encender lo nuevo** (camino 2): pasar una cara por el lector. En unos
   segundos debe aparecer en *Control de acceso → Hoy*.
8. Ir a la pestaña **Personas** y, en cada persona, elegir a qué socio
   corresponde. Esto se hace **una sola vez por socio**.
9. Listo: de ahí en adelante las entradas caen solas en Asistencia.

---

## Probar sin tener el lector enfrente

```bash
node puente/simular-lector.js
```

Manda al puente los mismos mensajes que mandaría el equipo real (en JSON, en
multipart con foto y un latido), para comprobar que toda la cadena funciona
antes de ir al gimnasio.

---

## Si no llega nada

Ir a **Control de acceso → Diagnóstico**. Ahí se ve, sin adornos, lo último que
llegó.

| Lo que se ve | Qué significa |
|---|---|
| La lista está vacía | El lector no está llegando a esta computadora. Revisar que estén en la misma red, la IP de la tabla C y que *Activar* esté encendido |
| Llegan mensajes pero dicen "no entendido" | El lector manda un formato distinto. Ese texto crudo es justo lo que hace falta para ajustarlo |
| Llegan y dicen "entendido", pero no hay asistencias | Falta vincular esa persona con su socio en la pestaña *Personas* |
| El puente dice que el puerto 80 está ocupado | Cambiar `puertoReceptor` en `puente/config.json` (ej. `8080`) y poner ese mismo puerto en el lector |

---

## Etapa 2 — opcional, cuando lleguen las credenciales

Con la IP y la contraseña del lector (tabla A) se abre lo siguiente, desde
*Control de acceso → Estado → Conexión directa al lector*:

- **Buscarlo en la red**: si nadie recuerda la IP, el puente recorre la red y
  dice cuáles equipos parecen el lector.
- **Traer sus personas**: baja la lista completa de gente dada de alta en el
  lector, aunque todavía no haya pasado por la puerta.
- **Traer registros viejos**: recupera los accesos de días en que el puente
  estuvo apagado.

Y queda escrito, pero **sin usar todavía**, dar de alta socios en el lector
desde el sitio (tarjeta, PIN y nivel de permiso). Eso se prende cuando ustedes
decidan; mientras tanto el puente solo lee.

---

## ¿Y desde internet, sin estar en el gimnasio?

Se puede, pero es otra etapa y más piezas:

- El sitio en Vercel **no puede** hablarle a una IP `192.168.x.x`: esa dirección
  solo existe dentro del gimnasio.
- Haría falta que el puente del gimnasio **suba** los datos a un servidor en
  internet, y que el sitio los lea de ahí. Es el mismo esquema descrito en
  [INTEGRACION-HDELEON.md](INTEGRACION-HDELEON.md), pieza 2.
- La pestaña *Registro Automático* del lector (puerto 9500) sirve para que el
  equipo marque hacia afuera cuando no tiene IP fija, pero habla un protocolo
  binario propio de Dahua, no HTTP: es bastante más trabajo que el camino de
  arriba.

**Recomendación:** primero dejarlo funcionando en la red del gimnasio, que es
donde de todos modos se registran las entradas. Lo de internet se agrega
después sin tirar nada de esto.

---

## Qué bases lee de Smart PSS Lite

De la carpeta `Data/System/Database/` de Smart PSS Lite (leyendo una copia):

| Archivo | Qué trae | Se usa |
|---|---|---|
| `ACSManagerDbFile.db` | Personas y tarjetas de control de acceso | Sí, como personas |
| `ACSEventInfo.db` | Registros de acceso (entradas) | Sí, como accesos |
| `ResourceManagerHistory.db` | Historial de eventos | Sí, como accesos |
| `RoleUserInfoData.db` | Cuentas del propio Smart PSS (operadores) | **No** — son del programa, no socios |
| `FaceRecognition.db` | Personas con rostro | Sí, si no está cifrada |

Los nombres de tabla y columna cambian entre versiones de Smart PSS, así que el
puente no asume un formato fijo: abre lo que haya y reconoce las columnas por su
forma (identificador de persona, nombre, tarjeta, fecha).

---

## Qué guarda el puente

En `puente/datos/puente.db` (SQLite, aparte de todo lo demás):

| Tabla | Qué tiene |
|---|---|
| `eventos_crudos` | Lo que llegó tal cual, para diagnosticar. Se conservan los últimos 500 |
| `accesos` | Cada paso ya interpretado: quién, cuándo, por rostro o tarjeta, concedido o rechazado |
| `personas` | La gente que el lector conoce |
| `vinculos` | Qué persona del lector es qué socio del sitio |
| `config` | Datos de conexión al lector |

Ese archivo y `puente/config.json` **no se suben a git** y **no se sirven al
navegador**: traen la contraseña del lector.
