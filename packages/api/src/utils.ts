import { createHash, randomBytes } from "node:crypto";

export const nowIso = (): string => new Date().toISOString();

export const makeId = (prefix: string): string => `${prefix}_${randomBytes(8).toString("hex")}`;

export const createApiKey = (): string => `pt_live_${randomBytes(24).toString("hex")}`;

export const hashApiKey = (key: string): string => createHash("sha256").update(key).digest("hex");

export const keyPrefix = (key: string): string => `${key.slice(0, 10)}****`;
