import { OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { registry } from "../src/schemas.js";
import * as fs from "fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");

const generator = new OpenApiGeneratorV3(registry.definitions);

const document = generator.generateDocument({
  openapi: "3.0.0",
  info: {
    title: "Human Service API",
    description:
      "Scrapes and caches a person's online presence (websites, LinkedIn, blog, etc.) to provide writing context for AI content generation.",
    version: "0.1.0",
  },
  servers: [
    {
      url: process.env.SERVICE_URL || "http://localhost:3000",
    },
  ],
});

const outputFile = join(projectRoot, "openapi.json");
fs.writeFileSync(outputFile, JSON.stringify(document, null, 2));
console.log("OpenAPI spec generated at", outputFile);
