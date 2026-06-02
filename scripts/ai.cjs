#!/usr/bin/env node

const { program } = require("commander");
const fs = require("fs");
const path = require("path");
const https = require("https");

// --- CONFIG & ENV ---
// برای اینکه .env رو از هر جایی پیدا کنه (چه ریشه پکیج، چه ریشه مونو-ریپو)
const possibleEnvPaths = [
  path.join(process.cwd(), ".env"),
  path.join(__dirname, "..", ".env"),
];

for (const envPath of possibleEnvPaths) {
  if (fs.existsSync(envPath)) {
    require("dotenv").config({ path: envPath });
    break;
  }
}

const API_KEY = process.env.API_KEY;
const API_HOSTNAME = process.env.API_HOSTNAME || "api.gapgpt.app";
const API_MODEL = process.env.API_MODEL || "gpt-4o";
// اگر متغیر محیطی NODE_TLS_REJECT_UNAUTHORIZED ست شده باشه یا در محیط توسعه باشیم
const IGNORE_SSL = process.env.IGNORE_SSL === "true" || true;

const PACKAGE_ROOT = path.resolve(__dirname, "..");
const PROMPTS_DIR = path.join(PACKAGE_ROOT, "prompts");

if (!API_KEY) {
  console.error("❌ Error: API_KEY is not set in .env file.");
  process.exit(1);
}

// --- HELPERS ---

function stripCodeFences(text) {
  return text
    .replace(/^```(?:tsx?|typescript|markdown|md)?\n?/i, "")
    .replace(/\n?```$/i, "")
    .trim();
}

function readPromptTemplate(fileName) {
  const promptPath = path.join(PROMPTS_DIR, fileName);
  if (!fs.existsSync(promptPath)) {
    throw new Error(`Prompt file not found: ${promptPath}`);
  }
  return fs.readFileSync(promptPath, "utf8");
}

function buildPrompt(template, variables) {
  let result = template;
  for (const [key, value] of Object.entries(variables)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, "g"), value);
  }
  return result;
}

// --- CORE API CALL ---

function callAI(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: API_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
    });

    const options = {
      hostname: API_HOSTNAME,
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
        "Content-Length": Buffer.byteLength(body),
      },
      // راه حل تو برای رفع ECONNRESET
      rejectUnauthorized: !IGNORE_SSL,
      timeout: 60000, // 60 seconds
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed?.choices?.[0]?.message?.content || "");
          } else {
            reject(new Error(`API Error (${res.statusCode}): ${JSON.stringify(parsed)}`));
          }
        } catch (e) {
          reject(new Error(`Failed to parse API response: ${data}`));
        }
      });
    });

    req.on("error", (err) => reject(err));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timed out"));
    });

    req.write(body);
    req.end();
  });
}

// سیستمی برای Retry خودکار در صورت بروز خطاهای شبکه مثل ECONNRESET
async function callAIWithRetry(prompt, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await callAI(prompt);
    } catch (err) {
      if (i === retries) throw err;
      const delay = Math.pow(2, i) * 1000;
      console.warn(
        `⚠️ Attempt ${i + 1} failed (${err.message}). Retrying in ${delay}ms...`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// --- COMMANDS ---

program
  .name("ai")
  .description("AI CLI for Monorepo code-to-docs conversion")
  .version("1.0.0");

const handleAction = async (input, output, templateFile, variableName) => {
  try {
    const inputPath = path.resolve(process.cwd(), input);
    if (!fs.existsSync(inputPath)) throw new Error(`File not found: ${inputPath}`);

    console.log(`🤖 Processing ${input}...`);
    const content = fs.readFileSync(inputPath, "utf8");
    const template = readPromptTemplate(templateFile);
    const prompt = buildPrompt(template, { [variableName]: content });

    const result = await callAIWithRetry(prompt);
    const finalContent = stripCodeFences(result) + "\n";

    if (output) {
      const outputPath = path.resolve(process.cwd(), output);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, finalContent, "utf8");
      console.log(`✅ Documentation generated at: ${output}`);
    } else {
      process.stdout.write(finalContent);
    }
  } catch (err) {
    console.error(`❌ Error: ${err.message}`);
    process.exit(1);
  }
};

program
  .command("to-md <input> [output]")
  .action((input, output) => handleAction(input, output, "ts-to-md.txt", "CODE"));

program
  .command("to-ts <input> [output]")
  .action((input, output) => handleAction(input, output, "md-to-ts.txt", "DOCS"));

program.parse(process.argv);
