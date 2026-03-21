import { getPref } from "../utils/prefs";

export interface TranslationConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  targetLanguage: string;
}

/**
 * Read the current translation configuration from plugin preferences.
 */
export function getTranslationConfig(): TranslationConfig {
  return {
    apiKey: getPref("apiKey"),
    baseUrl: getPref("apiBaseUrl"),
    model: getPref("apiModel"),
    targetLanguage: getPref("targetLanguage"),
  };
}

/**
 * Send a single text block to an OpenAI-compatible chat completions endpoint
 * and return the translated result.
 *
 * Uses a system prompt tuned for academic language: formal register,
 * preserve technical terminology, no over-localization.
 *
 * @param text - The text to translate (may contain multiple numbered paragraphs)
 * @param config - API credentials and settings
 * @returns The model's translation response
 * @throws If the API key is missing, the request fails, or the response is malformed
 */
export async function translateText(
  text: string,
  config: TranslationConfig,
): Promise<string> {
  if (!config.apiKey) {
    throw new Error(
      "API key is not configured. Please set it in plugin preferences.",
    );
  }
  if (!text.trim()) {
    return "";
  }

  const endpoint = config.baseUrl.replace(/\/$/, "") + "/chat/completions";

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        {
          role: "system",
          content:
            `You are a professional academic translator. ` +
            `Translate the following text into ${config.targetLanguage}. ` +
            `Preserve all technical terminology, proper nouns, and mathematical notation exactly as they appear. ` +
            `Maintain the formal register of academic writing. ` +
            `If the input contains numbered paragraphs like [1], [2], keep the same numbering in your output. ` +
            `Output only the translation with no explanations or commentary.`,
        },
        {
          role: "user",
          content: text,
        },
      ],
      temperature: 0.1,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "(no body)");
    throw new Error(`API request failed (HTTP ${response.status}): ${errorBody}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const translated = data?.choices?.[0]?.message?.content;
  if (!translated) {
    throw new Error(
      "Unexpected API response: missing choices[0].message.content",
    );
  }

  return translated;
}

/**
 * Translate an array of paragraph strings using the API.
 *
 * Paragraphs are sent as a single numbered batch so the model has full
 * context for each sentence. The response is parsed back into individual
 * paragraph strings in the same order.
 *
 * @param paragraphs - Non-empty strings to translate
 * @param config - API credentials and settings
 * @returns Array of translated strings, same length as input.
 *          Any paragraph the model failed to return will be an empty string.
 */
export async function translateParagraphs(
  paragraphs: string[],
  config: TranslationConfig,
): Promise<string[]> {
  if (paragraphs.length === 0) return [];

  // Wrap paragraphs in numbered markers so the model returns them in order
  const numbered = paragraphs.map((p, i) => `[${i + 1}] ${p}`).join("\n\n");

  const raw = await translateText(numbered, config);

  // Parse "[N] translated text" lines back into an array
  const results: string[] = new Array(paragraphs.length).fill("");
  // Split on blank lines then match each block
  const blocks = raw.split(/\n{1,2}/);
  for (const block of blocks) {
    const match = block.match(/^\[(\d+)\]\s*([\s\S]*)/);
    if (match) {
      const idx = parseInt(match[1], 10) - 1;
      if (idx >= 0 && idx < paragraphs.length) {
        results[idx] = match[2].trim();
      }
    }
  }

  return results;
}
