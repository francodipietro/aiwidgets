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
- [ ] Abrir PR y resolver la revisión.

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
- [ ] Añadir reintento individual y reintento global sin abrir ventanas extra.
- [ ] Distinguir “no conectado” de “sesión vencida” y “página cambió”.

Criterio de aceptación: cualquier tarjeta permite saber en un vistazo si su
valor es fresco y cómo recuperarlo cuando no lo sea.

## Fase 4 — privacidad y administración de cuentas

Objetivo: permitir salir de una cuenta de forma completa y comprensible.

- [ ] Botón “Disconnect” por proveedor.
- [ ] Borrar la partición aislada de cookies correspondiente y su configuración.
- [ ] Elegir si se conservan o eliminan las métricas guardadas; explicarlo en
  la UI.
- [ ] Añadir “Reset first-time setup” para volver al onboarding de forma
  deliberada.

Criterio de aceptación: cambiar de cuenta no reutiliza cookies ni datos de la
cuenta anterior por accidente.

## Fase 5 — alertas locales opcionales

Objetivo: avisar solo cuando el dato amerita atención, sin convertir la app en
una fuente de ruido.

- [ ] Preferencias por proveedor: umbrales de 20%, 10% y desactivado.
- [ ] Notificación local al cruzar un umbral, una vez por período de reset.
- [ ] Alerta opcional cuando falla un refresh durante un tiempo configurable.
- [ ] Respetar las preferencias de notificaciones del sistema operativo.

Criterio de aceptación: ninguna alerta se emite sin opt-in y no se repite para
la misma cuota/período.

## Fase 6 — historial local

Objetivo: hacer visibles tendencias sin enviar telemetría.

- [ ] Guardar muestras compactas de uso por proveedor.
- [ ] Retención configurable: 7, 30 o 90 días.
- [ ] Vista simple de tendencia por cuota.
- [ ] Exportar y borrar historial local.

Criterio de aceptación: el historial funciona sin red adicional y su tamaño y
retención son transparentes.

## Fase 7 — distribución y actualizaciones

Objetivo: instalar y actualizar con seguridad en ambas plataformas.

- [ ] Definir versionado y notas de release.
- [ ] Firmar y notarizar los paquetes de macOS antes de ofrecer instalación
  directa.
- [ ] Preparar paquetes `.deb` versionados para Ubuntu.
- [ ] Publicar un repositorio APT firmado para que `apt update` actualice el
  índice y `apt upgrade` instale versiones nuevas.
- [ ] Crear instalador one-liner que detecte macOS/Ubuntu, descargue el
  artefacto correcto y valide SHA-256.
- [ ] Añadir actualización integrada de macOS solo después de firma y
  notarización.

Criterio de aceptación: macOS instala sin advertencias de Gatekeeper y Ubuntu
recibe actualizaciones por su gestor de paquetes, sin requerir Node.js ni GitHub
CLI del usuario.

## Backlog posterior

- [ ] Internacionalización de interfaz y formatos de fecha.
- [ ] Accesibilidad: foco de teclado, etiquetas y contraste.
- [ ] Más proveedores, solo tras definir una fuente estable y el mismo modelo
  de privacidad local.
- [ ] Diagnóstico exportable y anonimizado para soporte, con consentimiento.
