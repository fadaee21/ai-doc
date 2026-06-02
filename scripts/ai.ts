#!/usr/bin/env node

/**
 * @file ai.ts
 * @version 2.0.0
 * @description TypeScript rewrite with strict types, enums, and layered architecture.
 *              Layered Architecture: Logger → Custom Errors → 
 * → AiService → Orchestrator → CLI
 */

import { program } from "commander";
import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import { IncomingMessage, RequestOptions } from "http";

// Loaded at bootstrap via dotenv
import "dotenv/config";

// ─── 1. CONSTANTS & CONFIG ────────────────────────────────────────────────────

/** Supported CLI sub-commands */
export enum CliCommand {
  ToMdx = "to-mdx",
  ToMd = "to-md",
  ToTs = "to-ts",
}

/** Names of the prompt template files in /prompts */
export enum PromptTemplate {
  TsToMdx = "ts-to-mdx.txt",
  TsToMd = "ts-to-md.txt",
  MdToTs = "md-to-ts.txt",
}

/** Template variable names injected into prompt files */
export enum PromptVar {
  Code = "CODE",
  Docs = "DOCS",
}

interface ApiConfig {
  readonly HOSTNAME: string;
  readonly MODEL: string;
  KEY: string | undefined; // mutable: populated after dotenv loads
  readonly TIMEOUT: number;
  readonly RETRY_LIMIT: number;
  readonly IGNORE_SSL: boolean;
}

interface PathsConfig {
  readonly PACKAGE_ROOT: string;
  readonly PROMPTS: string;
}

interface AppConfig {
  readonly API: ApiConfig;
  readonly PATHS: PathsConfig;
}

const PACKAGE_ROOT = path.resolve(__dirname, "..");

const CONFIG: AppConfig = {
  API: {
    HOSTNAME: process.env["API_HOSTNAME"] ?? "api.gapgpt.app",
    MODEL: process.env["API_MODEL"] ?? "gpt-4o",
    KEY: process.env["API_KEY"],
    TIMEOUT: 60_000,
    RETRY_LIMIT: 2,
    IGNORE_SSL: process.env["IGNORE_SSL"] === "true" || true,
  },
  PATHS: {
    PACKAGE_ROOT,
    PROMPTS: path.join(PACKAGE_ROOT, "prompts"),
  },
} as const;

// ─── 2. LOGGER LAYER ─────────────────────────────────────────────────────────

type AnsiCode = string;

interface LoggerColors {
  readonly reset: AnsiCode;
  readonly bright: AnsiCode;
  readonly red: AnsiCode;
  readonly green: AnsiCode;
  readonly yellow: AnsiCode;
  readonly blue: AnsiCode;
  readonly cyan: AnsiCode;
}

const COLORS: LoggerColors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
} as const;

const Logger = {
  info: (msg: string): void => console.log(`${COLORS.cyan}ℹ ${msg}${COLORS.reset}`),

  success: (msg: string): void => console.log(`${COLORS.green}✔ ${msg}${COLORS.reset}`),

  warn: (msg: string): void => console.warn(`${COLORS.yellow}⚠ ${msg}${COLORS.reset}`),

  error: (msg: string, detail = ""): void => {
    console.error(`${COLORS.red}${COLORS.bright}✖ Error: ${msg}${COLORS.reset}`);
    if (detail) {
      console.error(`${COLORS.red}╰─> ${detail}${COLORS.reset}`);
    }
  },

  step: (msg: string): void => console.log(`${COLORS.blue}🤖 ${msg}${COLORS.reset}`),
} as const;

// ─── 3. CUSTOM ERROR TYPES ────────────────────────────────────────────────────

class AppError extends Error {
  public readonly detail: string;

  constructor(message: string, detail = "") {
    super(message);
    this.detail = detail;
    this.name = this.constructor.name;
    // Restore prototype chain (required when extending built-ins in TS)
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

class FileSystemError extends AppError {}
class ApiError extends AppError {}
class NetworkError extends AppError {}

// ─── 4. FILE SERVICE LAYER ────────────────────────────────────────────────────

const FileService = {
  /**
   * Reads a file relative to cwd and returns its UTF-8 content.
   * @throws {FileSystemError} if the file does not exist or cannot be read.
   */
  read(filePath: string): string {
    try {
      const fullPath = path.resolve(process.cwd(), filePath);
      if (!fs.existsSync(fullPath)) {
        throw new Error(`File not found: ${filePath}`);
      }
      return fs.readFileSync(fullPath, "utf8");
    } catch (err) {
      throw new FileSystemError(
        "Failed to read file",
        err instanceof Error ? err.message : String(err),
      );
    }
  },

  /**
   * Writes content to a file, creating intermediate directories as needed.
   * @throws {FileSystemError} on any I/O failure.
   */
  write(filePath: string, content: string): void {
    try {
      const fullPath = path.resolve(process.cwd(), filePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content, "utf8");
    } catch (err) {
      throw new FileSystemError(
        "Failed to write file",
        err instanceof Error ? err.message : String(err),
      );
    }
  },

  /**
   * Reads a named prompt template from the configured prompts directory.
   * @throws {FileSystemError} if the template file is missing.
   */
  getPrompt(fileName: PromptTemplate): string {
    try {
      const promptPath = path.join(CONFIG.PATHS.PROMPTS, fileName);
      return fs.readFileSync(promptPath, "utf8");
    } catch (err) {
      throw new FileSystemError(
        `Prompt template missing: ${fileName}`,
        err instanceof Error ? err.message : String(err),
      );
    }
  },
} as const;

// ─── 5. AI SERVICE LAYER ─────────────────────────────────────────────────────

/** Shape of a single chat message sent to the completions endpoint */
interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/** Minimal subset of the completions API request body */
interface CompletionRequestBody {
  model: string;
  messages: ChatMessage[];
  temperature: number;
}

/** Minimal subset of a successful completions API response */
interface CompletionResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

const AiService = {
  /**
   * Sends a single prompt to the completions endpoint and resolves with the
   * model's reply text.
   *
   * @throws {ApiError} on non-2xx HTTP responses or malformed JSON.
   * @throws {NetworkError} on connection / timeout failures.
   */
  _sendRequest(prompt: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const body: CompletionRequestBody = {
        model: CONFIG.API.MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
      };

      const serializedBody = JSON.stringify(body);

      const options: RequestOptions & { rejectUnauthorized: boolean } = {
        hostname: CONFIG.API.HOSTNAME,
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${CONFIG.API.KEY}`,
          "Content-Length": Buffer.byteLength(serializedBody),
        },
        rejectUnauthorized: !CONFIG.API.IGNORE_SSL,
        timeout: CONFIG.API.TIMEOUT,
      };

      const req = https.request(options, (res: IncomingMessage) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data) as CompletionResponse;
            const statusCode = res.statusCode ?? 0;

            if (statusCode >= 200 && statusCode < 300) {
              resolve(parsed?.choices?.[0]?.message?.content ?? "");
            } else {
              reject(new ApiError(`API returned ${statusCode}`, JSON.stringify(parsed)));
            }
          } catch {
            reject(new ApiError("Invalid JSON response from AI API", data));
          }
        });
      });

      req.on("error", (err: Error) =>
        reject(new NetworkError("Connection failed", err.message)),
      );

      req.on("timeout", () => {
        req.destroy();
        reject(new NetworkError("Request timed out"));
      });

      req.write(serializedBody);
      req.end();
    });
  },

  /**
   * Orchestrates requests with exponential-backoff retry logic.
   * Only {@link NetworkError}s are retried; {@link ApiError}s surface immediately.
   *
   * @throws {NetworkError | ApiError} after all retry attempts are exhausted.
   */
  async requestWithRetry(prompt: string): Promise<string> {
    let lastError: Error = new Error("Unknown error");

    for (let attempt = 0; attempt <= CONFIG.API.RETRY_LIMIT; attempt++) {
      try {
        return await AiService._sendRequest(prompt);
      } catch (err) {
        if (!(err instanceof Error)) throw err;
        lastError = err;

        const isRetryable =
          err instanceof NetworkError && attempt < CONFIG.API.RETRY_LIMIT;

        if (isRetryable) {
          const delayMs = Math.pow(2, attempt) * 1_000;
          Logger.warn(
            `Retrying in ${delayMs}ms… (Attempt ${attempt + 1}/${CONFIG.API.RETRY_LIMIT})`,
          );
          await new Promise<void>((r) => setTimeout(r, delayMs));
          continue;
        }

        throw err;
      }
    }

    throw lastError;
  },
} as const;

// ─── 6. PROMPT UTILITIES ─────────────────────────────────────────────────────

const PromptUtils = {
  /**
   * Replaces all `{KEY}` placeholders in a template string with their values.
   */
  inject(template: string, vars: Record<string, string>): string {
    return Object.entries(vars).reduce(
      (acc, [key, value]) => acc.replace(new RegExp(`\\{${key}\\}`, "g"), value),
      template,
    );
  },

  /**
   * Strips leading/trailing markdown fenced code blocks from AI responses
   * and ensures the output ends with a single newline.
   */
  cleanResponse(text: string): string {
    return (
      text
        .replace(/^```(?:tsx?|typescript|markdown|md)?\n?/i, "")
        .replace(/\n?```$/i, "")
        .trim() + "\n"
    );
  },
} as const;

// ─── 7. TASK ORCHESTRATOR ─────────────────────────────────────────────────────

interface RunTaskOptions {
  /** Path to the source file to read */
  input: string;
  /** Optional output file path; if omitted, result is written to stdout */
  output?: string;
  /** Prompt template file to use */
  templateFile: PromptTemplate;
  /** Template variable name that will be replaced with file content */
  varName: PromptVar;
}

async function runTask({
  input,
  output,
  templateFile,
  varName,
}: RunTaskOptions): Promise<void> {
  try {
    Logger.step(`Starting task for: ${input}`);

    // 1. Load data
    const sourceCode = FileService.read(input);
    const template = FileService.getPrompt(templateFile);
    const finalPrompt = PromptUtils.inject(template, { [varName]: sourceCode });

    // 2. AI processing
    Logger.info("Communicating with AI service…");
    const rawResponse = await AiService.requestWithRetry(finalPrompt);
    const cleanContent = PromptUtils.cleanResponse(rawResponse);

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
      Logger.error("Unexpected Error", err instanceof Error ? err.message : String(err));
    }
    process.exit(1);
  }
}

// ─── 8. CLI BOOTSTRAP ─────────────────────────────────────────────────────────

function bootstrap(): void {
  const envPaths: string[] = [
    path.join(process.cwd(), ".env"),
    path.join(CONFIG.PATHS.PACKAGE_ROOT, ".env"),
  ];

  for (const envPath of envPaths) {
    if (fs.existsSync(envPath)) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("dotenv").config({ path: envPath });
      (CONFIG.API as { KEY: string | undefined }).KEY = process.env["API_KEY"];
      break;
    }
  }

  if (!CONFIG.API.KEY) {
    Logger.error("Environment Setup Failed", "API_KEY is missing in .env files.");
    process.exit(1);
  }

  program.name("ai").version("2.0.0");

  program
    .command(`${CliCommand.ToMdx} <input> [output]`)
    .description(
      "Generate MDX documentation (developer-facing) from a TypeScript/TSX file",
    )
    .action((input: string, output?: string) =>
      runTask({
        input,
        output,
        templateFile: PromptTemplate.TsToMdx,
        varName: PromptVar.Code,
      }),
    );

  program
    .command(`${CliCommand.ToMd} <input> [output]`)
    .description(
      "Generate Markdown documentation (AI/LLM-facing) from a TypeScript/TSX file",
    )
    .action((input: string, output?: string) =>
      runTask({
        input,
        output,
        templateFile: PromptTemplate.TsToMd,
        varName: PromptVar.Code,
      }),
    );

  program
    .command(`${CliCommand.ToTs} <input> [output]`)
    .description("Generate a TypeScript/TSX component from Markdown documentation")
    .action((input: string, output?: string) =>
      runTask({
        input,
        output,
        templateFile: PromptTemplate.MdToTs,
        varName: PromptVar.Docs,
      }),
    );

  try {
    program.parse(process.argv);
  } catch (err) {
    // Commander throws CommanderError for --help, --version, missing args etc.
    // Those are exit code 0 (help/version) — let them through silently.
    if (err instanceof Error && "code" in err) {
      const code = (err as { code: string }).code;
      if (code === "commander.helpDisplayed" || code === "commander.version") {
        process.exit(0);
      }
    }
    // No subcommand or wrong usage
    Logger.error("Invalid usage", "Run `pnpm ai --help` to see available commands.");
    process.exit(1);
  }

  // If parse succeeded but no subcommand was matched (bare `pnpm ai`)
  if (process.argv.length <= 2) {
    program.help(); // prints help and exits 0
  }
}

bootstrap();
