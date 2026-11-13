# Dashboard de Presupuesto

Aplicación web para gestionar presupuestos con **líneas jerárquicas** (padre/hijo/nieto), registro del **gasto real**, **desembolsos** (periodos de financiamiento) que se reparten entre las líneas y se arrastran al siguiente periodo, y un **dashboard** con filtros.

Pensada para usarse en local: cada usuario tiene sus propios datos y contraseñas con hash. No requiere build ni frameworks en el frontend.

## Características

- **Multiusuario** — registro e inicio de sesión; cada cuenta ve solo sus datos.
- **Líneas de presupuesto jerárquicas** — hasta cualquier nivel. Las líneas hijas se acumulan (roll-up) en el total del padre. Cada línea tiene **código** (podés escribir el tuyo), nombre y monto base.
- **Presupuesto General** — suma de todas las líneas según su jerarquía. Es la base que **no** modifican los desembolsos.
- **Desembolsos (periodos de financiamiento)** — cada uno con nombre, fecha, **monto recibido** y una **meta de ejecución** editable (80% por defecto). Al registrarlo, se reparte el dinero entre las líneas.
- **Reparto / Asignación** — asignás dinero a cualquier nivel (padres, hijos, nietos). Para gastar en una línea, primero tiene que tener dinero asignado en ese desembolso.
- **Saldo real (gasto)** — se registra el monto ejecutado por línea, fecha y desembolso; el dashboard calcula el porcentaje ejecutado.
- **Reserva y arrastre de saldo** — lo que no se repartió queda como reserva y se arrastra solo al siguiente desembolso. Con **«Pasar saldo al siguiente»** además se libera lo repartido y no gastado, y todo queda disponible para repartir en el próximo desembolso.
- **Ajustes de reparto** — movés dinero ya asignado de una línea a otra dentro del mismo desembolso (sin borrar gastos). Queda un registro con origen, destino, monto, nota y la ruta/nivel del origen.
- **Indicador de avance** — en cada desembolso (lista y detalle) se muestra el avance general frente a la meta, con barra de colores y marca en el objetivo.
- **Ajustes de presupuesto** — aumentan o reducen el presupuesto vigente de una línea. **La fecha es obligatoria** (validado en el servidor). Presupuesto vigente = monto base + ajustes.
- **Dashboard General** — KPIs, gráfica de ejecución mensual (área), distribución del gasto (torta interactiva) y árbol de líneas. Filtros por **Año / Mes / Desembolso** que afectan todo el dashboard (no el presupuesto base).
- **Exportar / Importar** — planilla Excel con las hojas: Líneas, Desembolsos, Asignaciones, Saldos reales, Ajustes, Traslados y Saldos trasladados. La importación **agrega** filas (no reemplaza).
- **Ajustes** — moneda del sistema y zona de peligro para **eliminar todos los datos** (con contraseña y aviso).

## 🚀 Instalación en Windows (Ejecutable .exe)

### Opción A: Descargar el instalador (recomendado)

1. Descargar `Dashboard de Presupuesto Setup 1.0.0.exe` desde la carpeta `dist/` o releases
2. Ejecutar el instalador
3. Seguir el asistente (crea accesos directos en Escritorio y Menú Inicio)
4. Abrir "Dashboard de Presupuesto" desde el menú Inicio

> **Datos persistentes:** Se guardan en `%APPDATA%\Presupuesto\data\budget.db` (sobreviven a actualizaciones y desinstalaciones).

### Opción B: Versión portable (sin instalación)

1. Descargar `Dashboard-de-Presupuesto-1.0.0-portable.exe` desde `dist/`
2. Ejecutar directamente (ideal para USB o carpetas sincronizadas)

---

## Inicio rápido (Node.js / Docker)

```bash
./install.sh          # menú interactivo (Docker o Node)
./install.sh --docker # Docker Compose (recomendado)
./install.sh --native # Node.js local
./install.sh --port 8080 --native   # cambio de puerto en modo nativo
```

- **Docker:** abrir http://localhost:43590
- **Nativo:** abrir http://localhost:3000

Los datos se guardan en SQLite dentro de `./data` y persisten entre reinicios.

### Manual

```bash
# Docker
docker compose up -d --build
# Node 20+ (better-sqlite3 es un módulo nativo: requiere toolchain de compilación)
npm install && npm start
```

> Cambios en el código: la imagen Docker "hornea" el código, así que hay que reconstruir con `docker compose up -d --build` para verlos.

---

## 🛠️ Desarrollo / Compilar el instalador

### Requisitos
- **Node.js 20 LTS** (Node 24 no tiene binarios precompilados para better-sqlite3)
- **Visual Studio Build Tools 2022** con workload "Desarrollo para el escritorio con C++"
- **Python 3.12+** (para node-gyp)

### Pasos
```bash
# 1. Instalar dependencias (compila better-sqlite3 nativamente)
npm install

# 2. Modo desarrollo (ventana Electron + DevTools)
npm run dev

# 3. Solo servidor Express (para probar en navegador)
npm start

# 4. Generar instaladores Windows
npm run build           # NSIS + portable (x64)
npm run build:portable  # Solo portable
npm run build:all       # x64 + ia32
```

Los instaladores se generan en `dist/`:
- `Dashboard de Presupuesto Setup 1.0.0.exe` — Instalador NSIS completo
- `Dashboard-de-Presupuesto-1.0.0-portable.exe` — Versión portable

---

## Estructura

```
├── electron-main.js      # Proceso principal Electron (Express integrado)
├── preload.js            # Puente seguro (IPC) para APIs nativas
├── server.js             # API Express original (referencia / modo servidor)
├── public/               # Frontend (HTML/CSS/JS, sin dependencias ni build)
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── installer.nsh         # Script NSIS personalizado (crea carpeta datos en AppData)
├── LICENSE.txt
├── package.json
├── Dockerfile
├── docker-compose.yml    # Publica 43590 -> 3000, volumen ./data
├── install.sh            # Instalador Linux/macOS (Docker / Node)
├── dist/                 # Instaladores generados (NO se sube a Git)
└── data/                 # Base SQLite modo nativo (se crea sola; NO se sube a Git)
```

El backend está completo en `server.js` (modo servidor) y replicado en `electron-main.js` (modo app nativa). El esquema se crea al arrancar (`CREATE TABLE IF NOT EXISTS`). No hay migraciones ni tests: la verificación es manual (arrancar y probar con el navegador o `curl`).

---

## API principal

Todas las rutas salvo `register`/`login` requieren la cookie de sesión. **Los `DELETE` requieren contraseña** en el cuerpo (`{ "password": "..." }`), excepto los traslados.

| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/api/register` | Crear usuario |
| POST | `/api/login` | Iniciar sesión |
| POST | `/api/logout` | Cerrar sesión |
| GET | `/api/me` | Usuario de la sesión |
| GET | `/api/data` | Todo: líneas, saldos reales, ajustes, desembolsos, asignaciones, traslados y saldos trasladados |
| POST | `/api/lines` | Crear línea (`name`, `amount`, `parent_id` opcional, `code` opcional) |
| PUT | `/api/lines/:id` | Editar línea (`name`, `amount`, `code`, `parent_id`) |
| DELETE | `/api/lines/:id` | Eliminar línea en cascada (requiere contraseña) |
| POST | `/api/executions` | Registrar gasto (`line_id`, `date`, `amount`, `note`, `disbursement_id`) |
| DELETE | `/api/executions/:id` | Eliminar gasto (requiere contraseña) |
| POST | `/api/adjustments` | Crear ajuste — **`date` obligatoria** (`line_id`, `date`, `amount`, `note`) |
| DELETE | `/api/adjustments/:id` | Eliminar ajuste (requiere contraseña) |
| POST | `/api/disbursements` | Crear desembolso (`name`, `date`, `amount`, `note`, `target_pct`) |
| PUT | `/api/disbursements/:id` | Editar desembolso (`name`, `date`, `amount`, `note`, `target_pct`) |
| DELETE | `/api/disbursements/:id` | Eliminar desembolso y sus datos (requiere contraseña) |
| POST | `/api/disbursements/:id/release-balance` | Liberar el saldo no gastado y pasarlo al siguiente desembolso (`note`) |
| POST | `/api/allocations` | Asignar dinero a una línea (`disbursement_id`, `line_id`, `amount`) |
| PUT | `/api/allocations/:id` | Editar asignación (`amount`) |
| DELETE | `/api/allocations/:id` | Eliminar asignación (requiere contraseña) |
| POST | `/api/allocations/transfer` | Mover dinero asignado entre líneas (`disbursement_id`, `from_line_id`, `to_line_id`, `amount`, `note`) |
| DELETE | `/api/data` | Eliminar **todos** los datos del usuario (requiere contraseña) |

---

## Datos y privacidad

- **Modo nativo (Node/Docker):** La base vive en `data/budget.db` (modo WAL).
- **App Windows instalada:** La base vive en `%APPDATA%\Presupuesto\data\budget.db`.
- **Portable:** La base vive junto al ejecutable en `data/budget.db`.
- **No la subas a Git:** contiene tus datos reales y contraseñas (con hash).
- Borrar la carpeta `data/` reinicia todo.
- Las contraseñas se guardan con hash `scrypt` + salt. La sesión es una cookie HttpOnly `budget_session` (30 días).

---

## Sin Docker (modo servidor clásico)

Requiere Node.js 20+:

```bash
npm install
npm start
```

El puerto se cambia con la variable de entorno `PORT` (por defecto 3000).

---

## Créditos / Licencia

Copyright © 2026 — Ver `LICENSE.txt`