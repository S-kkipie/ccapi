<p align="center">
  <img src="assets/ccapi.svg" width="440" alt="ccapi">
</p>

<p align="center">
  <b>Tu suscripción de Claude Code, como una API compatible con Anthropic.</b><br>
  Apunta cualquier SDK de Anthropic, LiteLLM o framework de agentes a localhost. Con tools, streaming e imágenes.
</p>

<p align="center">
  <a href="https://github.com/S-kkipie/ccapi/actions/workflows/test.yml"><img src="https://github.com/S-kkipie/ccapi/actions/workflows/test.yml/badge.svg" alt="tests"></a>
  <img src="https://img.shields.io/badge/Claude_Code-%E2%89%A5%202.1.291-E5483B" alt="Claude Code ≥ 2.1.291">
  <img src="https://img.shields.io/badge/runtime-Bun-FF9A5A" alt="Bun">
  <img src="https://img.shields.io/badge/license-MIT-44403C" alt="Licencia MIT">
</p>

<p align="center">
  <img src="assets/demo.gif" width="800" alt="demo de ccapi">
</p>

<p align="center"><a href="README.md">English</a> · Español</p>

---

Ya pagas Claude Code. ccapi deja que el resto de tus herramientas también lo usen: scripts, LiteLLM, frameworks de agentes, cualquier cosa que hable la Messages API de Anthropic. Corre una sesión de Claude Code con dos mods pequeños y sirve `/v1/messages` en `127.0.0.1`. Cambias la URL base y tu código sigue igual.

## Lo mejor

- **Reemplazo directo.** Mismo endpoint, mismos eventos SSE, mismas formas de error que la API de Anthropic.
- **Tools nativas.** Tus tools se vuelven tools reales de Claude Code, también en paralelo. Tu `tool_result` retoma el mismo subagente: sin trucos de prompt ni reenviar el historial.
- **Imágenes y PDFs**, en los mensajes y dentro de los resultados de tools.
- **Streaming de verdad**, token a token, desde el propio turno de Claude Code.
- **Thinking y effort**, `stop_sequences`, `/v1/models`, `count_tokens`.
- **No toca tus credenciales.** ccapi nunca lee tu token OAuth ni llama a la API de Anthropic por su cuenta. Todo pasa por Claude Code.

## Empezar

Necesitas [Claude Code](https://docs.claude.com/en/docs/claude-code) 2.1.291 o más nuevo (trae los mods), [Bun](https://bun.sh) y tmux, en Linux, macOS o WSL.

```bash
git clone https://github.com/S-kkipie/ccapi && cd ccapi
ln -s "$PWD/bin/ccapi" ~/.local/bin/ccapi

ccapi start     # Claude Code + los dos mods, en una sesión de tmux llamada "ccapi"
ccapi attach    # solo la primera vez: confía en la carpeta y sal con Ctrl-b d
ccapi status    # {"ok":true,...}
ccapi token     # tu API key local
```

Salúdalo:

```bash
curl http://127.0.0.1:18787/v1/messages \
  -H "x-api-key: $(ccapi token)" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-5-5","max_tokens":512,"messages":[{"role":"user","content":"¡Hola!"}]}'
```

## Úsalo desde

**SDK de Anthropic (TypeScript)**

```ts
import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({ apiKey: process.env.CCAPI_TOKEN, baseURL: 'http://127.0.0.1:18787' })
```

**SDK de Anthropic (Python)**

```python
import os
import anthropic

client = anthropic.Anthropic(api_key=os.environ["CCAPI_TOKEN"], base_url="http://127.0.0.1:18787")
```

**LiteLLM**, para clientes compatibles con OpenAI (hay una config completa en [`e2e/litellm.yaml`](e2e/litellm.yaml)):

```yaml
model_list:
  - model_name: claude-sonnet
    litellm_params:
      model: anthropic/claude-sonnet-5-5
      api_base: http://127.0.0.1:18787
      api_key: os.environ/CCAPI_TOKEN
```

```bash
LITELLM_MASTER_KEY=sk-... CCAPI_TOKEN=$(ccapi token) uvx --from 'litellm[proxy]' litellm --config e2e/litellm.yaml
```

**Hermes Agent**, y otros clientes que solo aceptan una URL propia de Anthropic si termina en `/anthropic`. ccapi acepta ese prefijo:

```yaml
# ~/.hermes/config.yaml
model:
  default: claude-sonnet-5-5
  provider: anthropic
  base_url: http://127.0.0.1:18787/anthropic
  api_mode: anthropic_messages
```

```bash
# ~/.hermes/.env (ANTHROPIC_TOKEN gana sobre CLAUDE_CODE_OAUTH_TOKEN y ANTHROPIC_API_KEY)
ANTHROPIC_TOKEN=<token de ccapi>
```

Modelos: `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-4-5-20251001`, los alias `opus`, `sonnet`, `haiku` y cualquier otro id `claude-*` que acepte tu Claude Code.

## 24/7

En un servidor, mantenlo arriba con una unidad systemd de usuario que reinicia Claude Code si se cae (después del primer `ccapi attach`, para que la carpeta ya sea de confianza):

```bash
ccapi install-service
loginctl enable-linger "$USER"   # arranca al iniciar, sin sesión abierta
systemctl --user start ccapi
```

Si tu cliente corre en otra máquina, un túnel SSH inverso deja el puerto en el localhost de esa máquina sin exponer nada:

```bash
ssh -N -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes -R 127.0.0.1:18787:127.0.0.1:18787 usuario@host
```

## Qué soporta

| Función | Estado |
| --- | --- |
| `POST /v1/messages`, JSON y streaming SSE | ✅ |
| Tools, llamadas en paralelo, `tool_choice` | ✅ `any` y `tool` son instrucciones, no restricciones duras |
| Imágenes y PDFs, en mensajes y en `tool_result` | ✅ |
| Extended thinking, effort | ✅ |
| `stop_sequences`, `max_tokens` | ✅ `max_tokens` es aproximado |
| `GET /v1/models`, `POST /v1/messages/count_tokens` | ✅ el conteo de tokens es estimado |
| Conversaciones de varios turnos | ✅ continuación nativa; un historial editado se reenvía como texto |
| `temperature`, `top_p`, `top_k`, `cache_control` | se ignoran (Claude Code cachea por su cuenta) |
| Message Batches, Files API | ❌ |

## Cómo funciona

`ccapi start` abre una sesión de Claude Code en tmux con dos mods. El mod principal levanta un servidor Bun pequeño en `127.0.0.1` y registra las tools de tu cliente como tools reales de Claude Code. Cada request se vuelve un subagente de Claude Code cuyo system prompt es tu `system`.

Cuando el modelo llama a una de tus tools, ccapi responde tu request con `stop_reason: "tool_use"` y deja el subagente en espera. Tu siguiente request trae el `tool_result`, que retoma ese mismo subagente en vez de empezar de cero. Los eventos de streaming salen directo del turno del engine, y las imágenes llegan al modelo como imágenes nativas de un resultado de tool.

El que lanza los subagentes es un mod aparte porque un mod no puede observar los subagentes que lanza él mismo.

## Configuración

| Opción | Por defecto | Qué hace |
| --- | --- | --- |
| `max_concurrent` | 4 | Subagentes a la vez; los demás requests esperan en cola |
| `queue_size` | 16 | Requests que pueden esperar antes de que ccapi responda 429 |
| `tool_wait_minutes` | 10 | Cuánto espera una tool en pausa tu `tool_result` |
| `expose_thinking` | `requested` | Cuándo te llegan los bloques de thinking: `requested`, `always`, `never` |
| `debug_bodies` | false | Guarda el cuerpo de los requests en el log |

Cada opción es una fila en `/config` dentro de la sesión de ccapi (`ccapi attach`). `CCAPI_PORT` cambia el puerto (por defecto `18787`) y `CCAPI_SERVER_DIR` la carpeta de la sesión (por defecto `~/.ccapi/server`). Los requests se registran en `~/.local/state/ccapi/requests.jsonl`.

| Comando | |
| --- | --- |
| `ccapi start` / `stop` | Arranca o detiene la sesión de tmux |
| `ccapi status` | Salud de la API |
| `ccapi token` | Muestra la API key local (guardada en `~/.config/ccapi/token`, modo 0600) |
| `ccapi attach` | Abre la sesión (sal con Ctrl-b d) |
| `ccapi install-service` | Instala la unidad systemd de usuario |

## Para tener en cuenta

- El system prompt siempre empieza con "You are a Claude agent, built on Anthropic's Claude Agent SDK.". Claude Code lo agrega a cada subagente y no se puede quitar.
- Cada request gasta el uso de tu plan, como cualquier sesión de Claude Code.
- Si se cierra la sesión, la API se cae con ella. `ccapi install-service` la levanta sola.
- Los mods que instalaste con `/plugin install` también cargan en la sesión de ccapi y ven sus subagentes. Los cargados con `CLAUDE_CODE_PLUGIN_DIRS`, no.
- La API de mods de Claude Code está en early access y puede cambiar.

## Úsalo con responsabilidad

ccapi es para uso personal en tu propia máquina. Gasta tu propio plan a través de Claude Code. Déjalo en localhost, no compartas tu token y no atiendas a otras personas con tu suscripción: los [términos de consumidor](https://www.anthropic.com/legal/consumer-terms) de Anthropic no permiten pasar tráfico de terceros por planes Free, Pro o Max. Para productos y equipos, usa una [API key de Anthropic](https://console.anthropic.com).

## Desarrollo

```bash
bun install
bun run test          # tests unitarios (núcleo puro + bridge)
bun run typecheck
bun run test:plugin   # claude plugin test
bun run validate      # claude plugin validate
bun run e2e           # contra un server corriendo (ccapi start)
```

Issues y pull requests son bienvenidos. Mantén el núcleo de `plugins/ccapi/src` sin APIs de Node ni del DOM (los mods corren sin ellas) y pon los tests junto al código, en `__tests__/`.

## Licencia

[MIT](LICENSE). ccapi es un proyecto independiente, sin relación ni respaldo de Anthropic. Claude y Claude Code son marcas de Anthropic, PBC.
