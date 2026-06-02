#!/usr/bin/env node

/**
 * @file ai.cjs
 * @version 1.2.0
 * @description Refactored with Layered Architecture: Logger, Custom Errors, and Service Separation.
 */

const { program } = require("commander");
const fs = require("fs");
const path = require("path");
const https = require("https");

// --- 1. CONSTANTS & CONFIG ---

const CONFIG = {
  API: {
    HOSTNAME: process.env.API_HOSTNAME || "api.gapgpt.app",
    MODEL: process.env.API_MODEL || "gpt-4o",
    KEY: process.env.API_KEY,
    TIMEOUT: 60000,
    RETRY_LIMIT: 2,
    IGNORE_SSL: process.env.IGNORE_SSL === "true" || true,
  },
  PATHS: {
    PACKAGE_ROOT: path.resolve(__dirname, ".."),
    PROMPTS: path.join(path.resolve(__dirname, ".."), "prompts"),
  },
};

// --- 2. LOGGER LAYER (Colorized Output) ---

const Logger = {
  colors: {
    reset: "\x1b[0m",
    bright: "\x1b[1m",
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    cyan: "\x1b[36m",
  },
  info: (msg) => console.log(`${Logger.colors.cyan}ℹ ${msg}${Logger.colors.reset}`),
  success: (msg) => console.log(`${Logger.colors.green}✔ ${msg}${Logger.colors.reset}`),
  warn: (msg) => console.warn(`${Logger.colors.yellow}⚠ ${msg}${Logger.colors.reset}`),
  error: (msg, detail = "") => {
    console.error(
      `${Logger.colors.red}${Logger.colors.bright}✖ Error: ${msg}${Logger.colors.reset}`,
    );
    if (detail) console.error(`${Logger.colors.red}╰─> ${detail}${Logger.colors.reset}`);
  },
  step: (msg) => console.log(`${Logger.colors.blue}🤖 ${msg}${Logger.colors.reset}`),
};

// --- 3. CUSTOM ERROR TYPES ---

class AppError extends Error {
  constructor(message, detail) {
    super(message);
    this.detail = detail;
    this.name = this.constructor.name;
  }
}

class FileSystemError extends AppError {}
class ApiError extends AppError {}
class NetworkError extends AppError {}

// --- 4. FILE SYSTEM LAYER (I/O) ---

const FileService = {
  read: (filePath) => {
    try {
      const fullPath = path.resolve(process.cwd(), filePath);
      if (!fs.existsSync(fullPath)) throw new Error(`File not found: ${filePath}`);
      return fs.readFileSync(fullPath, "utf8");
    } catch (err) {
      throw new FileSystemError("Failed to read file", err.message);
    }
  },

  write: (filePath, content) => {
    try {
      const fullPath = path.resolve(process.cwd(), filePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content, "utf8");
    } catch (err) {
      throw new FileSystemError("Failed to write file", err.message);
    }
  },

  getPrompt: (fileName) => {
    try {
      const promptPath = path.join(CONFIG.PATHS.PROMPTS, fileName);
      return fs.readFileSync(promptPath, "utf8");
    } catch (err) {
      throw new FileSystemError(`Prompt template missing: ${fileName}`, err.message);
    }
  },
};

// --- 5. AI SERVICE LAYER (Communication) ---

const AiService = {
  /** Internal method to handle the raw HTTPS request */
  _sendRequest: (prompt) => {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        model: CONFIG.API.MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
      });

      const options = {
        hostname: CONFIG.API.HOSTNAME,
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${CONFIG.API.KEY}`,
          "Content-Length": Buffer.byteLength(body),
        },
        rejectUnauthorized: !CONFIG.API.IGNORE_SSL,
        timeout: CONFIG.API.TIMEOUT,
      };

      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(parsed?.choices?.[0]?.message?.content || "");
            } else {
              reject(
                new ApiError(`API returned ${res.statusCode}`, JSON.stringify(parsed)),
              );
            }
          } catch (e) {
            reject(new ApiError("Invalid JSON response from AI API", data));
          }
        });
      });

      req.on("error", (err) =>
        reject(new NetworkError("Connection failed", err.message)),
      );
      req.on("timeout", () => {
        req.destroy();
        reject(new NetworkError("Request timed out"));
      });
      req.write(body);
      req.end();
    });
  },

  /** Orchestrates requests with retry logic */
  requestWithRetry: async (prompt) => {
    let lastError;
    for (let i = 0; i <= CONFIG.API.RETRY_LIMIT; i++) {
      try {
        return await AiService._sendRequest(prompt);
      } catch (err) {
        lastError = err;
        // Only retry on Network errors or specific server timeouts
        if (err instanceof NetworkError && i < CONFIG.API.RETRY_LIMIT) {
          const delay = Math.pow(2, i) * 1000;
          Logger.warn(
            `Retrying in ${delay}ms... (Attempt ${i + 1}/${CONFIG.API.RETRY_LIMIT})`,
          );
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw err; // Rethrow if it's an ApiError or we're out of retries
      }
    }
    throw lastError;
  },
};

// --- 6. CORE LOGIC (Orchestrator) ---

const PromptUtils = {
  inject: (template, vars) => {
    let result = template;
    for (const [k, v] of Object.entries(vars)) {
      result = result.replace(new RegExp(`\\{${k}\\}`, "g"), v);
    }
    return result;
  },
  cleanResponse: (text) =>
    text
      .replace(/^```(?:tsx?|typescript|markdown|md)?\n?/i, "")
      .replace(/\n?```$/i, "")
      .trim() + "\n",
};

async function runTask({ input, output, templateFile, varName }) {
  try {
    Logger.step(`Starting task for: ${input}`);

    // 1. Load Data
    const sourceCode = FileService.read(input);
    const template = FileService.getPrompt(templateFile);
    const finalPrompt = PromptUtils.inject(template, { [varName]: sourceCode });

    // 2. AI Processing
    Logger.info("Communicating with AI service...");
    const rawAiResponse = await AiService.requestWithRetry(finalPrompt);
    const cleanContent = PromptUtils.cleanResponse(rawAiResponse);

    // 3. Output
    if (output) {
      FileService.write(output, cleanContent);
      Logger.success(`Successfully generated: ${output}`);
    } else {
      process.stdout.write(cleanContent);
    }
  } catch (err) {
    if (err instanceof FileSystemError) {
      Logger.error("File System Failure", err.detail);
    } else if (err instanceof ApiError) {
      Logger.error("AI API Refused Request", err.detail);
    } else if (err instanceof NetworkError) {
      Logger.error("Network / Connectivity Issue", err.detail);
    } else {
      Logger.error("Unexpected Error", err.message);
    }
    process.exit(1);
  }
}

// --- 7. CLI INITIALIZATION ---

function bootstrap() {
  const envPaths = [
    path.join(process.cwd(), ".env"),
    path.join(CONFIG.PATHS.PACKAGE_ROOT, ".env"),
  ];
  for (const p of envPaths) {
    if (fs.existsSync(p)) {
      require("dotenv").config({ path: p });
      CONFIG.API.KEY = process.env.API_KEY;
      break;
    }
  }

  if (!CONFIG.API.KEY) {
    Logger.error("Environment Setup Failed", "API_KEY is missing in .env files.");
    process.exit(1);
  }

  program.name("ai").version("1.2.0");

  program
    .command("to-md <input> [output]")
    .action((input, output) =>
      runTask({ input, output, templateFile: "ts-to-md.txt", varName: "CODE" }),
    );

  program
    .command("to-ts <input> [output]")
    .action((input, output) =>
      runTask({ input, output, templateFile: "md-to-ts.txt", varName: "DOCS" }),
    );

  program.parse(process.argv);
}

bootstrap();
