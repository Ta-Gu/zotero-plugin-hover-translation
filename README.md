# Zotero Hover Translation

[![Zotero 7](https://img.shields.io/badge/Zotero-7-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue?style=flat-square)](LICENSE)
[![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)

Hover-based AI-powered sentence translation for Zotero's built-in PDF reader.

Read academic papers in their original language. Move your mouse over any sentence to instantly see a translation — no text selection, no right-clicking, no leaving the reading flow.

## How It Works

Traditional translation plugins require you to select text first. This plugin takes a different approach:

1. Click the **Prepare Hover Translations** button in the PDF toolbar
2. The plugin extracts every sentence from the PDF along with its position on the page
3. All sentences are translated via your configured LLM API and cached locally
4. A transparent overlay is injected into the PDF reader — hovering any sentence shows its pre-computed translation in a speech-bubble tooltip

Because translations are cached after the first run, subsequent opens of the same PDF are instant with no API calls.

## Installation

1. Go to the [Releases](../../releases) page and download the latest `hover-translation-x.x.x.xpi`
2. In Zotero: **Tools → Add-ons → Install Add-on From File…** and select the `.xpi`
3. Restart Zotero

Requires **Zotero 7** or later.

## Configuration

Go to **Tools → Hover Translation Settings** (or **Edit → Preferences → Hover Translation**).

| Setting | Description | Example |
|---------|-------------|---------|
| API Key | Your API key for the LLM provider | `sk-...` |
| API Base URL | Base URL of the OpenAI-compatible API | `https://api.openai.com/v1` |
| Model | Model name to use for translation | `gpt-4o-mini` |
| Target Language | Language to translate into | `Chinese`, `Japanese`, `French` |

### Supported API Providers

Any OpenAI-compatible API endpoint works:

- **OpenAI** — `https://api.openai.com/v1` with `gpt-4o-mini` (recommended for cost/quality balance)
- **DeepSeek** — `https://api.deepseek.com/v1` with `deepseek-chat`
- **Ollama** (local) — `http://localhost:11434/v1` with your local model name

## Usage

1. Open a PDF in Zotero's reader
2. Click the **Prepare Hover Translations** button in the toolbar (the translation icon)
3. Wait for the progress indicator to finish — this sends all sentences to the API
4. Move your mouse over any sentence to see the translation appear above it

The tooltip is fixed to the full sentence extent, so moving between lines of a long sentence keeps the tooltip stable.

## Privacy & Cost

- Your PDF text is sent to whichever API you configure. Use a local Ollama instance if you need full privacy.
- Only the first open of each PDF incurs API calls. Translations are cached in `hover-translation-cache.json` in your Zotero data directory.
- To clear the cache (e.g., to force re-translation with a different language), use the **Clear All Cache** button in the preferences pane.

## Comparison with Similar Tools

| | Hover Translation | Zotero PDF Translate | zotero-pdf2zh |
|--|--|--|--|
| Interaction | Hover | Select text | Batch (full doc) |
| Translation scope | Sentence | Selection | Full document |
| Output | Inline tooltip | Popup / sidebar | New bilingual PDF |
| API required | Yes | Yes | Local Python server |
| Preserves original text | Yes | Yes | No (replaces) |

## Development

```sh
git clone https://github.com/ta-gu/zotero-plugin-hover-translation.git
cd zotero-plugin-hover-translation
npm install
npm run build          # production build → .scaffold/build/hover-translation.xpi
npm start              # dev server with hot reload
```

Unit tests for the sentence detection logic (no Zotero dependency):

```sh
node scripts/test-sentences.mjs
```

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).