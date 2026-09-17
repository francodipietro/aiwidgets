# AI Widgets — roadmap de producto

Este plan parte de `feature/first-run-provider-onboarding`. Cada fase debe
terminar con una prueba local antes de abrir una PR. No se empaqueta ni se
publica una versión hasta que su fase esté validada.

## Principios

- Privacidad local: cookies, métricas e historial permanecen en el equipo.
- Ningún proveedor se activa ni se conecta sin una elección explícita.
- La interfaz siempre muestra si el dato es actual, está vencido o falló.
- En macOS y Ubuntu se mantiene el mismo significado de los datos, aunque la
  integración visual sea nativa de cada plataforma.
- Las pruebas de primera ejecución usan un perfil temporal separado de las
  sesiones reales:

  ```bash
  task_profile="$(mktemp -d /private/tmp/aiwidgets-first-run.XXXXXX)"
  env -u ELECTRON_RUN_AS_NODE AIWIDGETS_TEST_USER_DATA="$task_profile" npm run dev
  ```

## Forma de trabajo

Para cada entrega:

1. Crear una rama pequeña desde `main`.
2. Implementar una única mejora coherente.
3. Ejecutar `npm run check` y `git diff --check`.
4. Probar localmente el flujo afectado; si es primera ejecución, usar el perfil
   temporal aislado y no iniciar sesión salvo que se haya acordado.
5. Commit, push, PR y revisión.
6. Empaquetar DMG/DEB solo después del merge.

## Fase 1 — onboarding de primera ejecución

Objetivo: que una instalación nueva no presuponga ningún proveedor y lleve al
usuario desde su elección explícita hasta las acciones de login.

- [x] Crear datos nuevos con `enabledProviders: []`.
- [x] Persistir `onboardingComplete` sin enviar usuarios existentes de vuelta
  al onboarding.
- [x] Mostrar Claude, Codex y GitHub Copilot desmarcados en la primera apertura.
- [x] Continuar a los botones de conexión de los proveedores elegidos.
- [x] Probar visualmente la primera pantalla con un perfil aislado, sin tocar
  cookies ni configuración reales.
- [x] Confirmar localmente la transición “seleccionar → Continue to sign in”
  para una selección de proveedor, sin completar ningún login.
- [x] Abrir PR y resolver la revisión.

Criterio de aceptación: en un perfil vacío no hay tarjetas ni refresh de un
proveedor hasta que el usuario lo selecciona; una instalación existente
conserva sus proveedores activos y no muestra el onboarding.

## Fase 2 — base de calidad y regresiones

Objetivo: detectar cambios en las páginas de los proveedores antes de que
lleguen a una versión publicada.

- [x] Extraer funciones puras de parsing de uso y fechas de reset.
- [x] Añadir fixtures anonimizados de Claude, Codex y GitHub Copilot.
- [x] Añadir pruebas para porcentajes, cuotas faltantes, fechas vencidas y
  páginas parcialmente cargadas.
- [x] Añadir pruebas para la migración de datos anteriores al onboarding.
- [x] Incorporar `npm test` al checklist local.

Criterio de aceptación: un cambio de parser no puede mergearse sin pruebas de
las tres fuentes y los casos de error principales.

## Fase 3 — estado de salud de conexiones

Objetivo: que el usuario pueda confiar en cada tarjeta sin adivinar la edad o
el origen del dato.

- [x] Guardar último refresh exitoso, último intento y error normalizado por
  proveedor.
- [x] Mostrar “Updated just now / 5 min ago”, estado vencido y error accionable.
- [x] Añadir reintento individual y reintento global sin abrir ventanas extra.
- [x] Distinguir “no conectado” de “sesión vencida” y “página cambió”.

Criterio de aceptación: cualquier tarjeta permite saber en un vistazo si su
valor es fresco y cómo recuperarlo cuando no lo sea.

## Fase 4 — privacidad y administración de cuentas

Objetivo: permitir salir de una cuenta de forma completa y comprensible.

- [x] Botón “Disconnect” por proveedor.
- [x] Borrar la partición aislada de cookies correspondiente y su configuración.
- [x] Elegir si se conservan o eliminan las métricas guardadas; explicarlo en
  la UI.
- [x] Añadir “Reset first-time setup” para volver al onboarding de forma
  deliberada.

Criterio de aceptación: cambiar de cuenta no reutiliza cookies ni datos de la
cuenta anterior por accidente.

## Fase 5 — alertas locales opcionales

Objetivo: avisar solo cuando el dato amerita atención, sin convertir la app en
una fuente de ruido.

- [x] Preferencias por proveedor: alertas activadas o desactivadas, con
  umbrales fijos por tipo de cuota — sesión al 75% y 90% de consumo, y cada
  20% en las cuotas semanales y mensuales.
- [x] Notificación local al cruzar un escalón, una vez por cuota y período de
  reset. Solo se anuncia el escalón más alto alcanzado, de modo que un salto
  grande entre dos refrescos produce un aviso y no varios.
- [x] Alerta opcional cuando un proveedor deja de actualizarse, repetida cada
  10, 30 o 60 minutos, con la opción de silenciar el episodio en curso desde
  la tarjeta del proveedor.
- [x] Respetar las preferencias de notificaciones del sistema operativo.

Criterio de aceptación: ninguna alerta se emite sin opt-in y ninguna alerta de
cuota se repite para la misma cuota/período. Las alertas de fallo sí repiten a
propósito —un colector roto sigue roto— hasta que el proveedor vuelve a
actualizarse o el usuario silencia ese episodio.

## Fase 6 — historial local

Objetivo: hacer visibles tendencias sin enviar telemetría.

- [x] Guardar muestras compactas de uso por proveedor. Un punto por cuota,
  sólo cuando el valor cambia respecto del último guardado — el archivo
  crece con el uso real, no con el tiempo.
- [x] Retención configurable: 7, 30 o 90 días. Al cambiarla se poda de
  inmediato, no en la siguiente escritura.
- [x] Vista simple de tendencia por cuota: un sparkline compacto (línea +
  área, eje temporal real, sin ejes visibles) por cuota, en un panel propio.
- [x] Exportar (JSON, vía diálogo nativo) y borrar historial local (global,
  con confirmación; y por proveedor, siguiendo la misma elección de
  preservar/borrar de "Disconnect" en la Fase 4).

Criterio de aceptación: el historial funciona sin red adicional y su tamaño y
retención son transparentes.

## Fase 7 — distribución y actualizaciones

Objetivo: instalar y actualizar con seguridad en ambas plataformas.

- [ ] Definir versionado y notas de release.
- [ ] Firmar y notarizar los paquetes de macOS antes de ofrecer instalación
  directa.
- [x] Preparar paquetes `.deb` versionados para Ubuntu, con la extensión GNOME
  (menú superior y tarjetas de escritorio) incluida en el paquete.
- [ ] Publicar un repositorio APT firmado para que `apt update` actualice el
  índice y `apt upgrade` instale versiones nuevas.
- [ ] Crear instalador one-liner que detecte macOS/Ubuntu, descargue el
  artefacto correcto y valide SHA-256.
- [ ] Añadir actualización integrada de macOS solo después de firma y
  notarización.

Criterio de aceptación: macOS instala sin advertencias de Gatekeeper y Ubuntu
recibe actualizaciones por su gestor de paquetes, sin requerir Node.js ni GitHub
CLI del usuario.

## Fase 8 — proveedor DeepSeek por API

Objetivo: sumar un proveedor que no se conecta por página web sino por API key,
y que expone saldo en lugar de cuota de porcentaje. Es el primer proveedor de
este tipo y sienta el patrón para futuros proveedores por API.

- [ ] Guardar la API key cifrada con `safeStorage` en un archivo propio
  (`deepseek-credentials.json`), nunca en `usage.json`.
- [ ] Leer el balance desde `GET https://api.deepseek.com/user/balance` con un
  colector por `fetch` (nuevo tipo `api` junto al de páginas en `main.js`).
- [ ] Barra única de disponibilidad: denominador = `granted_balance +
  topped_up_balance`, disponible = `total_balance`, y usado derivado por resta
  (`used = granted + topped_up − total_balance`), que es el "Total cost" de la
  web. No hace falta historial local ni un denominador inventado.
- [ ] Las recargas no requieren lógica especial: `topped_up_balance` y
  `total_balance` suben juntos, así que `used` no cambia y la barra se rellena
  sola. Mostrar un umbral configurable de "saldo bajo".
- [ ] Onboarding y tarjeta DeepSeek con una acción "Conectar" que pide la API
  key (no una ventana de login).
- [ ] Alerta opcional de saldo bajo, respetando el modelo de opt-in de la
  Fase 5.
- [ ] "Disconnect" borra la key cifrada; reutilizar el flujo de privacidad de
  la Fase 4.
- [ ] Fixtures y pruebas de parseo del balance (`total_balance`,
  `granted_balance`, `topped_up_balance`, moneda), recarga y errores (401 =
  key inválida).

Criterio de aceptación: la key nunca queda en texto plano en disco, la barra de
disponibilidad refleja el saldo real (`available / total` y usado derivado) y
una recarga rellena la barra sin reinterpretar el aumento como consumo. El dato
queda local e igual en macOS y Ubuntu.

## Backlog posterior

- [ ] Internacionalización de interfaz y formatos de fecha.
- [ ] Accesibilidad: foco de teclado, etiquetas y contraste.
- [ ] Más proveedores, solo tras definir una fuente estable y el mismo modelo
  de privacidad local; reutilizar el patrón de API key de la Fase 8 cuando
  corresponda.
- [ ] Diagnóstico exportable y anonimizado para soporte, con consentimiento.
