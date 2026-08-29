# Ollama Usage Breakdown

[![CodeQL](https://github.com/srnoob2570/ollama-usage-breakdown/actions/workflows/codeql.yml/badge.svg)](https://github.com/srnoob2570/ollama-usage-breakdown/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/srnoob2570/ollama-usage-breakdown/badge)](https://scorecard.dev/viewer/?uri=github.com/srnoob2570/ollama-usage-breakdown)

**Créditos:** Este script de usuario fue creado originalmente por **srnoob0237** en Discord, y modificado por **manytricks**.

Un script de usuario para Tampermonkey que hace que los medidores de uso en [ollama.com/settings](https://ollama.com/settings) sean realmente legibles, con un desglose por modelo de tu uso de Ollama Cloud.

![Medidores de uso de sesión y semanales con desglose por modelo de solicitudes y porcentajes](./docs/session.png) ![Medidor semanal con porcentajes por modelo](./docs/weekly.png)

> También disponible en inglés: [README.md](./README.md)

> Este script de usuario es generado y actualizado con asistencia de IA. No está afiliado ni respaldado por Ollama. Consulta el [descargo de responsabilidad completo](#descargo-de-responsabilidad-generado-por-ia) más abajo.

## Qué hace

- **Desglose de sesión.** Agrega una lista de "Modelos usados en esta sesión" debajo del medidor de sesión, con el mismo estilo que la lista nativa de Ollama "Modelos usados esta semana" (punto de color, nombre del modelo, cantidad de solicitudes) más una columna adicional.
- **Porcentajes por modelo.** Ollama solo muestra el "X% usado" global y el conteo de solicitudes. La participación de cada modelo solo existe en el HTML de la página, codificada como anchos de segmentos de la barra. El script lee esos anchos, los reescala contra el uso total y muestra cuánto de tu límite total consumió cada modelo. Juntos suman el X% que Ollama reporta (ej. `84.2%` de un `10.7%` de sesión → `9.01%`).
- **Porcentajes semanales también.** Inyecta el mismo porcentaje reescalado en la lista nativa de "Modelos usados esta semana" de Ollama.
- **Horas exactas de reinicio.** Agrega la fecha y hora absoluta junto a cada reinicio relativo, ej. "Reinicia en 2 horas. (27 de agosto de 2026 a las 2:00 AM)".
- Sobrevive a actualizaciones htmx y navegación SPA, y se limpia solo cuando sales de la página de configuración.

## Instalación

1. Instala [Tampermonkey](https://www.tampermonkey.net/) en tu navegador.
2. Abre el script en crudo: <https://raw.githubusercontent.com/srnoob2570/ollama-usage-breakdown/main/ollama-usage-breakdown.user.js>
3. Tampermonkey te ofrecerá instalarlo. Luego visita <https://ollama.com/settings>.

### Manual

Abre el panel de Tampermonkey, crea un nuevo script y pega el contenido de [`ollama-usage-breakdown.user.js`](./ollama-usage-breakdown.user.js). Guarda y luego visita <https://ollama.com/settings>.

## Notas

- Los porcentajes se leen de la página de Ollama (anchos de segmentos de la barra), no de una API privada. Si Ollama cambia su marcado, es posible que el script necesite una actualización.
- El script solo se ejecuta en `https://ollama.com/settings` (URL exacta, no en `/settings/keys`, `/settings/billing` o `/settings/profile`) y no necesita permisos especiales (`@grant none`).

## Seguridad

Este script se ejecuta en tu navegador, por lo que nunca debes confiar ciegamente en él:

- Un único archivo legible: [`ollama-usage-breakdown.user.js`](./ollama-usage-breakdown.user.js) — sin pasos de compilación, sin ofuscación, sin dependencias.
- Sin APIs de scripts de usuario privilegiadas (`@grant none`): sin solicitudes entre orígenes, sin acceso a otras pestañas, al portapapeles o al almacenamiento de Tampermonkey. Todo lo que muestra se analiza del DOM de la página.
- Se ejecuta solo en `https://ollama.com/settings` (URL exacta) y solo lee lo que la página ya te muestra.
- Cada push y pull request se escanea automáticamente con [CodeQL](https://github.com/srnoob2570/ollama-usage-breakdown/security/code-scanning) usando las consultas de seguridad de GitHub.

Las insignias de arriba no demuestran la ausencia de malware — ninguna insignia puede hacerlo. Lee el script antes de instalarlo y revisa el diff que Tampermonkey muestra en cada actualización.

## Descargo de responsabilidad: Generado por IA

Este script de usuario está escrito y mantenido con la ayuda de IA. No está afiliado, respaldado ni conectado a Ollama de ninguna manera.

- La IA lo escribe y un humano lo revisa antes de cada lanzamiento. Ambos pueden equivocarse, por lo que aún puede contener errores o romperse cuando Ollama cambie su sitio web.
- Úsalo bajo tu propio riesgo, y siempre revisa un script de usuario antes de instalarlo.
- Las incidencias y solicitudes de extracción son bienvenidas, incluyendo correcciones para cualquier error de la IA.
