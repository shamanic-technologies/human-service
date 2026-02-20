import Anthropic from "@anthropic-ai/sdk";
import type { ScrapedPage } from "../db/schema.js";

export interface ExtractedProfile {
  writingStyle: string;
  bio: string;
  topics: string[];
  tone: string;
  vocabulary: string;
}

export interface ExtractionResult {
  profile: ExtractedProfile;
  inputTokens: number;
  outputTokens: number;
}

export async function extractProfile(
  name: string,
  pages: ScrapedPage[],
  anthropicApiKey: string
): Promise<ExtractionResult> {
  const client = new Anthropic({ apiKey: anthropicApiKey });

  const pagesContext = pages
    .map((p) => `--- ${p.title} (${p.url}) ---\n${p.content}`)
    .join("\n\n");

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2000,
    messages: [
      {
        role: "user",
        content: `Analyze the following web pages about "${name}" and extract their profile. Return a JSON object with these fields:

- writingStyle: How they write (e.g., "Conversational, first-person, uses short paragraphs")
- bio: A concise bio summary (2-3 sentences)
- topics: Array of topics they cover (e.g., ["AI", "entrepreneurship"])
- tone: Their communication tone (e.g., "Authentic, honest, direct")
- vocabulary: Notable words/phrases they frequently use

Pages:
${pagesContext}

Respond with ONLY valid JSON, no markdown fences.`,
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  const text = textBlock && "text" in textBlock ? textBlock.text : "{}";

  let parsed: ExtractedProfile;
  try {
    parsed = JSON.parse(text) as ExtractedProfile;
  } catch {
    parsed = {
      writingStyle: "",
      bio: "",
      topics: [],
      tone: "",
      vocabulary: "",
    };
  }

  return {
    profile: {
      writingStyle: parsed.writingStyle || "",
      bio: parsed.bio || "",
      topics: parsed.topics || [],
      tone: parsed.tone || "",
      vocabulary: parsed.vocabulary || "",
    },
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}
