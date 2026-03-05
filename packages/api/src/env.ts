import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const ENV_FILES = [".env.local", ".env"] as const;

let loaded = false;

const loadOptionalEnvFile = (path: string): void => {
  try {
    process.loadEnvFile(path);
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : null;
    if (code !== "ENOENT") {
      throw error;
    }
  }
};

export const loadApiEnv = (): void => {
  if (loaded) return;
  for (const file of ENV_FILES) {
    loadOptionalEnvFile(join(REPO_ROOT, file));
  }
  loaded = true;
};
