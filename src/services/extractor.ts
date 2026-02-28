import Anthropic from "@anthropic-ai/sdk";
import type {
  Framework,
  ToneProfile,
  PersuasionStyle,
} from "../db/schema.js";
import type { ScrapeResult } from "./scraping.js";

export interface ExtractedData {
  bio: string;
  expertise: string[];
  knownFor: string;
  frameworks: Framework[];
  strategicPatterns: string[];
  toneOfVoice: ToneProfile;
  persuasionStyle: PersuasionStyle;
  contentSignatures: string[];
  avoids: string[];
}

export interface ExtractionResult {
  data: ExtractedData;
  inputTokens: number;
  outputTokens: number;
}

const EMPTY_EXTRACTION: ExtractedData = {
  bio: "",
  expertise: [],
  knownFor: "",
  frameworks: [],
  strategicPatterns: [],
  toneOfVoice: {
    register: "",
    pace: "",
    vocabulary: "",
    perspective: "",
    examples: [],
  },
  persuasionStyle: {
    primary: "",
    techniques: [],
    callToAction: "",
  },
  contentSignatures: [],
  avoids: [],
};

export async function extractMethodology(
  name: string,
  pages: ScrapeResult[],
  anthropicApiKey: string
): Promise<ExtractionResult> {
  const client = new Anthropic({ apiKey: anthropicApiKey });

  const pagesContext = pages
    .map((p) => `=== PAGE: ${p.url} ===\n${p.markdown}`)
    .join("\n\n");

  // Cap total input at 100k chars
  const truncatedContext = pagesContext.slice(0, 100000);

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: `Analyze the following web pages about "${name}" and extract a comprehensive methodology profile.

Return a JSON object with these exact fields:

{
  "bio": "2-3 sentence bio summary",
  "expertise": ["domain1", "domain2"],
  "knownFor": "What they are most famous for (1 sentence)",
  "frameworks": [
    {
      "name": "Framework Name",
      "description": "What the framework is and how it works",
      "applicationContext": "When and how to apply it"
    }
  ],
  "strategicPatterns": [
    "Recurring pattern in their approach (e.g., 'lead with value before asking')"
  ],
  "toneOfVoice": {
    "register": "casual-authoritative | formal | academic | conversational",
    "pace": "fast, direct | measured, deliberate",
    "vocabulary": "simple words, concrete numbers | technical jargon",
    "perspective": "first-person, experience-based | third-person analytical",
    "examples": ["2-3 short excerpts that capture the tone"]
  },
  "persuasionStyle": {
    "primary": "value-first | scarcity | social-proof | authority | logical",
    "techniques": ["specificity", "risk-reversal", "social-proof-by-numbers"],
    "callToAction": "How they typically close"
  },
  "contentSignatures": [
    "Recognizable style markers (e.g., 'uses bold claims backed by numbers')"
  ],
  "avoids": [
    "Things they explicitly avoid (e.g., 'never uses jargon')"
  ]
}

If you cannot determine a field from the available content, use an empty string for string fields or an empty array for array fields.

Pages:
${truncatedContext}

Respond with ONLY valid JSON, no markdown fences.`,
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  const text = textBlock && "text" in textBlock ? textBlock.text : "{}";

  let parsed: Partial<ExtractedData>;
  try {
    parsed = JSON.parse(text) as Partial<ExtractedData>;
  } catch {
    parsed = {};
  }

  const data: ExtractedData = {
    bio: parsed.bio || EMPTY_EXTRACTION.bio,
    expertise: parsed.expertise || EMPTY_EXTRACTION.expertise,
    knownFor: parsed.knownFor || EMPTY_EXTRACTION.knownFor,
    frameworks: parsed.frameworks || EMPTY_EXTRACTION.frameworks,
    strategicPatterns:
      parsed.strategicPatterns || EMPTY_EXTRACTION.strategicPatterns,
    toneOfVoice: parsed.toneOfVoice
      ? {
          register: parsed.toneOfVoice.register || "",
          pace: parsed.toneOfVoice.pace || "",
          vocabulary: parsed.toneOfVoice.vocabulary || "",
          perspective: parsed.toneOfVoice.perspective || "",
          examples: parsed.toneOfVoice.examples || [],
        }
      : EMPTY_EXTRACTION.toneOfVoice,
    persuasionStyle: parsed.persuasionStyle
      ? {
          primary: parsed.persuasionStyle.primary || "",
          techniques: parsed.persuasionStyle.techniques || [],
          callToAction: parsed.persuasionStyle.callToAction || "",
        }
      : EMPTY_EXTRACTION.persuasionStyle,
    contentSignatures:
      parsed.contentSignatures || EMPTY_EXTRACTION.contentSignatures,
    avoids: parsed.avoids || EMPTY_EXTRACTION.avoids,
  };

  return {
    data,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}
