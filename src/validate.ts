import Ajv2020, { type ErrorObject } from "ajv/dist/2020";
import configSchema from "../schema/opencode.schema.json";
import modelsSchema from "../schema/models-dev.schema.json";
import type { JsonObject } from "./config";
import { validateAuthData, type AuthValue } from "./auth";

export interface ValidationIssue {
  path: string;
  message: string;
  keyword: string;
}

let validator: ReturnType<Ajv2020["compile"]> | undefined;
let validatorError: string | undefined;

function getValidator() {
  if (validator) return validator;
  if (validatorError) throw new Error(validatorError);
  try {
    const ajv = new Ajv2020({
      allErrors: true,
      strict: false,
      allowUnionTypes: true,
      validateFormats: false,
    });
    ajv.addSchema(modelsSchema as object, "https://models.dev/model-schema.json");
    validator = ajv.compile(configSchema as object);
    return validator;
  } catch (error) {
    validatorError = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not compile bundled schema: ${validatorError}`);
  }
}

function toIssue(error: ErrorObject): ValidationIssue {
  return {
    path: error.instancePath || "(root)",
    message: error.message ?? "is invalid",
    keyword: error.keyword,
  };
}

export function validateConfigData(data: JsonObject): ValidationIssue[] {
  const validate = getValidator();
  const ok = validate(data);
  if (ok) return [];
  return (validate.errors ?? []).map(toIssue);
}

export interface ValidationReport {
  schemaErrors: ValidationIssue[];
  warnings: string[];
}

export function validateConfig(data: JsonObject, text: string): ValidationReport {
  const warnings: string[] = [];
  if (!text.includes("$schema")) {
    warnings.push('Config has no "$schema" line; editors cannot provide completion/validation.');
  } else if (!text.includes("https://opencode.ai/config.json")) {
    warnings.push('"$schema" does not point at https://opencode.ai/config.json.');
  }
  const schemaErrors: ValidationIssue[] = [];
  for (const issue of validateConfigData(data)) {
    // The bundled schema restricts small_model to models.dev IDs. OpenCode itself
    // accepts any model defined by a configured (e.g. custom) provider.
    if (issue.path === "/small_model" && issue.keyword === "enum") {
      warnings.push(
        "small_model is not a models.dev ID known to the bundled schema; " +
          "OpenCode will still use it when the provider defines the model.",
      );
    } else {
      schemaErrors.push(issue);
    }
  }
  return { schemaErrors, warnings };
}

export function validateAuthFile(data: Record<string, AuthValue>): string[] {
  return validateAuthData(data);
}

/** Validate a provider/model reference such as "openrouter/anthropic/claude-sonnet". */
export function validateModelReference(value: string): string | undefined {
  if (!value.trim()) return "Model reference is required";
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) {
    return 'Model must use the "provider/model" format';
  }
  if (/\s/.test(value)) return "Model reference must not contain whitespace";
  return undefined;
}

export function formatIssues(issues: ValidationIssue[]): string[] {
  return issues.map((issue) => `${issue.path}: ${issue.message} [${issue.keyword}]`);
}
