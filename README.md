# Mi Diario

Agregador de noticias personal y gratuito: recoge noticias de unos 50 medios fiables (117 feeds de España, EE. UU., internacional, ciencia, tecnología, economía y deportes), agrupa la misma historia contada por varios medios, la ordena según tus intereses y genera resúmenes con IA. Se usa como web o se instala como app (PWA).

👉 El análisis completo de viabilidad, costes y aspectos legales está en [`docs/estudio-viabilidad.md`](docs/estudio-viabilidad.md).

## Cómo funciona

```
Cron del Worker de Cloudflare → GitHub Actions (cada 30 min de 7 a 1 h, dos veces de madrugada; IA cada 2 h)
  └─ npm run ingest
       1. descarga los RSS de sources.json
       2. limpia, deduplica y calcula un embedding multilingüe por artículo (modelo local, sin API)
       3. clasifica en secciones/subsecciones (reglas + prototipos de embeddings para los casos dudosos)
       4. agrupa la misma noticia entre medios y entre español e inglés, y marca spoilers de la NBA
       5. Gemini (gratis; de reserva Groq y GitHub Models): un briefing por sección + resúmenes de sus noticias top
       6. escribe web/data/news.json (y los vectores de las noticias en web/data/vectors.json)
       7. añade las noticias al archivo semanal (web/data/weekly/: las más importantes de cada semana)
  └─ despliega en Cloudflare Workers: web/ (assets) + src/worker.js (API de sincronización, KV)

Navegador (web/)
  carga news.json → ordena con tu perfil (algoritmo que aprende de tus ❤️) → feeds
  (o, si lo eliges arriba de la lista, por más recientes o por nº de medios)
```

| Ruta | Qué es |
|---|---|
| `sources.json` | Medios y feeds, cada uno con su sección por defecto (añadir/quitar fuentes aquí) |
| `web/lib/taxonomy.js` | Secciones, subsecciones y palabras clave para clasificar |
| `web/lib/spoilers.js` | Detector de resultados de la NBA |
| `scripts/ingest/weekly.js` | Archivo semanal (el modo *Semana* de cada feed): las noticias más importantes de cada semana, por sección y subsección |
| `scripts/ci/freshness.js` | Edad de la última edición (la usan *Actualizar noticias* y *Vigilar noticias*) |
| `src/worker.js` | Worker: sirve la web y guarda el perfil sincronizado (KV) |
| `scripts/ingest/` | Descarga, parseo, clasificación, agrupación y resúmenes IA (`jobs.js` decide qué noticias van a cada llamada; `embed.js`, los embeddings; `prototypes.js`, los prototipos de sección) |
| `scripts/eval/` | Pares de titulares reales etiquetados y `cluster-eval.js`, que mide la agrupación (`npm run eval:cluster`) |
| `web/` | La web/PWA estática (sin build); `sw.js` la deja funcionar sin conexión con la última edición |
| `web/lib/rank.js` | Algoritmo de personalización (regresión logística online) |
| `web/lib/profile.js` | Perfil del usuario, migración y fusión al sincronizar |
| `web/lib/corrections.js` | Botón 🏷️ Sección: mover una noticia de sección (y las parecidas); se sincroniza y se puede copiar desde Ajustes para afinar el clasificador |
| `test/` | Tests (`npm test`; el workflow *CI* los pasa en cada PR) |

## Probar en local

Requiere Node 20+.

```bash
npm install
npm run ingest            # genera web/data/news.json
GEMINI_API_KEY=xxx npm run ingest   # igual, con resúmenes IA
npm run dev               # abre http://localhost:5173
npm test
npm run eval:cluster      # mide la agrupación con los pares etiquetados (compara los modelos)
```

La primera vez, `npm run ingest` descarga el modelo de embeddings (~130 MB) a `.cache/models`; los vectores ya calculados se guardan en `.cache/embeddings.json`. `ONNXRUNTIME_NODE_INSTALL=skip npm install` evita que `onnxruntime-node` baje ~300 MB de CUDA que aquí no se usan.

`npm run dev` sirve solo la web estática: sin el Worker no hay sincronización ni inicio de sesión. Para probarlo todo, `npx wrangler dev` (usa `web/` y `src/worker.js`, con un KV local; las invitaciones de prueba van en `.dev.vars` como `INVITES=yo:mi-codigo`).

## Ponerla en internet (gratis)

1. **Clave de IA (opcional):** crea una API key en [Google AI Studio](https://aistudio.google.com/apikey).
2. **Cloudflare:** en *My Profile → API Tokens → Create Token*, usa la plantilla **"Edit Cloudflare Workers"** y copia el token. Copia también tu **Account ID** (aparece en la página de *Workers & Pages*). El worker `mi-diario` se crea solo en el primer despliegue.
3. **En GitHub → Settings → Secrets and variables → Actions:**
   - Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `GEMINI_API_KEY` y, como IA de reserva, `GROQ_API_KEY` (gratis en [console.groq.com/keys](https://console.groq.com/keys)): si Gemini falla, los resúmenes se hacen con Groq
   - Variables (opcionales): `GEMINI_MODEL` (por defecto los alias `gemini-flash-latest` → `gemini-flash-lite-latest`) `GROQ_MODEL` (por defecto `openai/gpt-oss-120b` → `llama-3.3-70b-versatile`) y `GITHUB_MODELS_MODEL` (por defecto `openai/gpt-4.1-mini` → `openai/gpt-4o-mini`).
   - **GitHub Models** es la última reserva y no necesita clave: el workflow usa su propio `GITHUB_TOKEN` (permiso `models: read`). Para probarla, *Run workflow* con la IA `github`.
4. El workflow *Actualizar noticias* se ejecuta cada 30 min de 7:00 a 1:00 (hora de España, en verano) y dos veces de madrugada, en cada push a `main` y a mano desde *Actions → Actualizar noticias → Run workflow*. Quien lo lanza a su hora es el **cron del Worker** de Cloudflare (el de GitHub se retrasa horas o no llega a ejecutarse; queda de reserva y no hace nada si la edición tiene menos de 20 min). Para activarlo:
   - En GitHub, *Settings (de tu cuenta) → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token*: solo este repositorio, permiso **Actions: Read and write**, la caducidad que quieras.
   - En Cloudflare, *Workers & Pages → mi-diario → Settings → Variables and Secrets → Add*, tipo **Secret**, nombre `GITHUB_DISPATCH_TOKEN` y el token como valor. En una copia, cambia también `GITHUB_REPO` en `wrangler.jsonc` (y añade ahí `GITHUB_BRANCH` si tu rama principal no se llama `main`).
   - El Worker reintenta si GitHub falla (5xx o red) y deja en sus logs (*Workers & Pages → mi-diario → Logs*) cada lanzamiento y cada error. Un `GitHub dispatch 401/403/404` significa que el token caducó o perdió el permiso: crea otro y actualiza el secreto. Apunta la fecha de caducidad en tu calendario.
   - Sin ese secreto todo funciona igual, pero solo con el cron de GitHub. Los resúmenes IA se regeneran cada 2 h; en las ejecuciones intermedias entran noticias nuevas y se conservan los resúmenes anteriores. Con la web abierta, cada 10 min comprueba `data/meta.json` y, si hay edición nueva, muestra el botón "Hay noticias nuevas · Actualizar".
5. **Aviso al móvil si las noticias se paran (recomendado):** el propio Worker lo vigila, porque el cron de GitHub no es fiable (el workflow *Vigilar noticias* llegó a ejecutarse una vez en 6 horas). Instala la app gratuita **ntfy** en el móvil, suscríbete a un tema largo y difícil de adivinar (p. ej. `mi-diario-x7k2p9`) y en Cloudflare crea la variable de texto `NTFY_TOPIC` con ese nombre. Cada 30 min (de 7:17 a 22:47 UTC) el Worker lee `data/meta.json`; si la edición tiene más de 90 min te manda **un** aviso, y otro cuando vuelve a funcionar. Sin `NTFY_TOPIC` solo escribe el aviso en sus logs.

   Además, el workflow *Vigilar noticias* sigue abriendo un issue (por correo) si defines la variable `SITE_URL` en *Settings → Secrets and variables → Actions → Variables* (p. ej. `https://mi-diario.TU-SUBDOMINIO.workers.dev`), pero llega tarde o no llega si GitHub no lanza su cron. Con `SITE_URL`, el cron de reserva de *Actualizar noticias* también decide con esa fecha si hay algo que hacer, antes de instalar nada.
6. Abre la web en el móvil → menú del navegador → **"Añadir a pantalla de inicio" / "Instalar app"**.

### Solo para quien invites (inicio de sesión)

La web puede pedir un **código de invitación**: cada persona tiene el suyo, lo escribe una vez y queda dentro (la sesión dura más de un año en ese dispositivo). Cada código es una cuenta: sus gustos se guardan en la nube y le siguen a cualquier dispositivo donde entre.

1. En Cloudflare, *Workers & Pages → mi-diario → Settings → Variables and Secrets → Add*, tipo **Text** (para poder consultar los códigos ahí cuando quieras; si prefieres que no se vean, **Secret**), nombre `INVITES` y como valor un `nombre:código` por persona, separados por comas:
   ```
   jaime:sol-mesa-rio-47, ana:luna-pan-verde-12, pepe:tren-azul-casa-83
   ```
   Usa códigos largos e inventados (3-4 palabras y un número). Ponlo solo en Cloudflare, nunca en `wrangler.jsonc`: el repo es público y cualquiera vería los códigos. `keep_vars` en `wrangler.jsonc` hace que los despliegues no borren la variable.
2. Pásale a cada amigo la URL de la web y **su** código.
3. Para invitar a alguien, añade su `nombre:código`; para quitarle el acceso, borra su entrada (o cámbiale el código).

Sin `INVITES` la web está abierta a cualquiera, como antes. El workflow funciona igual en los dos casos: la edición anterior (de la que salen los resúmenes que se conservan) la guarda en la caché de Actions.

## Protección y seguridad del repo

- **CI** (`.github/workflows/ci.yml`): pasa `npm test` en cada pull request.
- **Regla para `main`** (`.github/rulesets/main.json`): en *Settings → Rules → Rulesets → New ruleset → Import a ruleset*, sube ese archivo. Exige que los cambios a `main` lleguen por PR con los *Tests* en verde y prohíbe borrarla o reescribir su historia. Como admin puedes saltártela en una emergencia (casilla *bypass* al fusionar).
- **Dependabot** (`.github/dependabot.yml`): PRs semanales para actualizar dependencias npm y actions. Activa también las alertas en *Settings → Code security → Dependabot alerts*.
- **CodeQL** (`.github/workflows/codeql.yml`): análisis de seguridad del código en cada PR y cada lunes; los avisos salen en *Security → Code scanning*.
- **Secretos:** en *Settings → Code security*, comprueba que *Secret scanning* y *Push protection* están activados: bloquean un push que lleve una clave de Gemini, Groq o Cloudflare.

## Hazte tu propia copia

1. En la página del repo pulsa **Use this template → Create a new repository** (o *Fork*). Puede ser privado o público.
2. **Base de datos de sincronización (KV):** el `id` de `wrangler.jsonc` es el de mi cuenta y en la tuya no existe. En Cloudflare ve a *Storage & Databases → KV → Create* (nombre, p. ej., `mi-diario-profiles`), copia su **ID** y sustitúyelo en `wrangler.jsonc` (se puede editar desde la web de GitHub con el lápiz ✏️).
3. Sigue los pasos de [Ponerla en internet](#ponerla-en-internet-gratis): tus propios secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `GEMINI_API_KEY` (y `GROQ_API_KEY` si quieres) y, en Cloudflare, el secreto `GITHUB_DISPATCH_TOKEN` del cron del Worker, con `GITHUB_REPO` apuntando a tu repo en `wrangler.jsonc`.
4. En la pestaña **Actions** de tu repo, activa los workflows si GitHub lo pide y lanza *Actualizar noticias → Run workflow*. En los forks GitHub desactiva las ejecuciones programadas hasta que las activas a mano.
5. Para personalizarla: añade o quita medios en `sources.json` y ajusta secciones y palabras clave en `web/lib/taxonomy.js`.

## Agrupación con embeddings

Cada artículo (titular + extracto) se convierte en un vector con [`paraphrase-multilingual-MiniLM-L12-v2`](https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2) (ONNX cuantizado, CPU, [transformers.js](https://huggingface.co/docs/transformers.js)). Dos artículos son la misma noticia si su similitud (coseno + nombres propios y cifras en común − marcadores distintos) supera 0,66, a menos de 36 h; la agrupación es jerárquica de enlace medio. Se eligió el modelo y el umbral midiendo con 338 pares reales etiquetados: el algoritmo anterior, por palabras, agrupaba el 8 % de las noticias repetidas; este, el 80 % con un 83 % de precisión, también entre español e inglés. Detalles y cifras en el [estudio de viabilidad](docs/estudio-viabilidad.md#21-agrupación-y-clasificación-con-embeddings-coste-0).

- Otro modelo: variable `EMBED_MODEL` (en GitHub, en *Settings → Secrets and variables → Actions → Variables*) (los candidatos y sus umbrales están en `scripts/ingest/embed.js`); `EMBED_MODEL=off` vuelve a la agrupación por palabras, que también se usa si el modelo no carga.
- Si cambias el método, vuelve a medir con `npm run eval:cluster` (y añade pares a `scripts/eval/pairs.json` si ves errores).
- `web/data/vectors.json` guarda el vector de cada noticia (int8 en base64) para una futura búsqueda y ordenación por significado; la web todavía no lo usa.

## Secciones

Para ti · España (Política, Economía, Sociedad, Deportes, Cultura) · EE. UU. (Política, Economía, Sociedad, NBA, NFL, Deporte universitario) · Internacional (Europa, Latinoamérica, Oriente Medio, Asia y otros) · Ciencia (Física, Espacio, Vida y salud, Clima) · Tecnología (IA, Empresas y gadgets, Innovación) · Economía (Mercados, Empresas, Energía) · Deportes (Fútbol, Baloncesto, Tenis, Fútbol americano, Rugby, Béisbol, Deportes de invierno, Atletismo, Ciclismo, Resistencia, Motor, Combate, Deportes acuáticos, Otros).

Cada sección tiene su resumen IA arriba (y la NBA uno propio, sin resultados). Las rutas se pueden enlazar: `#/s/eeuu/nba`.

## Ahora / Semana

Arriba de cada feed (Para ti, cada sección y cada subsección) hay un interruptor **Ahora | Semana**. *Ahora* es el feed de siempre; *Semana* enseña las noticias más importantes de la semana en ese mismo feed (de lunes a domingo, hora de España): las 20 primeras en Para ti y las 10 primeras de cada sección y subsección. Con ‹ › se pasa a semanas anteriores; se guardan las últimas 12. El modo se mantiene al cambiar de sección y la web siempre abre en *Ahora*.

- **Importancia** = el máximo de medios que llegaron a cubrir la noticia en alguna edición (y, a igualdad, si se contó en español e inglés). No se personaliza el orden, pero sí se quitan las noticias ocultas, los medios silenciados, las palabras silenciadas y los idiomas que no lees.
- Cada noticia cuenta en la semana en que salió su primer artículo; la semana en curso se va completando con cada edición. Se conserva su resumen IA y los spoilers de la NBA siguen tapados.
- Se guarda en `web/data/weekly/` (un archivo por semana más `index.json`), que el workflow conserva en la caché de Actions como la edición anterior. Si esa caché se pierde (GitHub la borra tras 7 días sin usarse), el archivo empieza de nuevo desde la semana en curso.

## Cómo aprende

- **❤️ Me gusta**, **Guardar** y **abrir** una noticia son señales positivas; **👎** y **Ocultar**, negativas. Si una noticia te aparece arriba en 3 visitas distintas y nunca la abres, cuenta como un "no" suave (solo para su sección y medio).
- Cada noticia se describe con rasgos: sección y subsección, medio, palabras y pares de palabras del titular y nombres propios ("Golden State", "CERN"). Un modelo de **regresión logística online** ajusta el peso de cada rasgo con cada señal; lo aprendido se va olvidando un 3 % al día.
- Orden final = tu preferencia por la sección (Ajustes) + lo aprendido + nº de medios que la cubren + frescura, con diversidad de temas y, en Para ti, 1 de cada 10 noticias "para descubrir" fuera de lo habitual.
- Cada tarjeta dice por qué te la enseña (♥ NBA · Física) y en Ajustes puedes ver y olvidar lo aprendido.

## Sin spoilers de la NBA

Las noticias de la NBA con marcadores, "X gana a Y", estadísticas de partido o eliminatorias aparecen tapadas ("Posible spoiler · Mostrar") en todos los feeds. Nunca se envían a la IA, y el resumen de la NBA tiene prohibido dar resultados (con un filtro posterior). Se puede desactivar o añadir palabras en Ajustes.

## Sincronizar móvil y PC

Con inicio de sesión no hace falta nada: entra con tu código en cada dispositivo. Sin él: Ajustes → *Sincronizar dispositivos* → *Activar* y abre el enlace en el otro dispositivo. El perfil se guarda en Cloudflare KV (gratis) bajo un código aleatorio de 128 bits; se sube solo cuando cambia, como mucho cada 15 s (el plan gratuito de KV admite 1.000 escrituras al día), y se descarga al abrir la web. El perfil también se puede exportar/importar como archivo.
