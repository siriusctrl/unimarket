export type AnalysisRenderRequest = {
  market: string;
  reference: string;
  documentId: string;
  scope: "chart" | "page";
  theme: "dark" | "light";
  width: number;
  height: number;
};

const requiredText = (params: URLSearchParams, name: string, maxLength: number): string => {
  const value = params.get(name)?.trim();
  if (!value || value.length > maxLength) throw new Error(`${name} is required and must be at most ${maxLength} characters`);
  return value;
};

const boundedInteger = (params: URLSearchParams, name: string, fallback: number, min: number, max: number): number => {
  const raw = params.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
};

export const parseRenderRequest = (url: URL): AnalysisRenderRequest => {
  const scope = url.searchParams.get("scope") ?? "chart";
  if (scope !== "chart" && scope !== "page") throw new Error("scope must be chart or page");
  const theme = url.searchParams.get("theme") ?? "dark";
  if (theme !== "dark" && theme !== "light") throw new Error("theme must be dark or light");

  return {
    market: requiredText(url.searchParams, "market", 120),
    reference: requiredText(url.searchParams, "reference", 200),
    documentId: requiredText(url.searchParams, "documentId", 120),
    scope,
    theme,
    width: boundedInteger(url.searchParams, "width", 1440, 800, 2400),
    height: boundedInteger(url.searchParams, "height", 1000, 600, 1800)
  };
};

export const buildAnalysisUrl = (webBaseUrl: string, request: AnalysisRenderRequest): string => {
  const target = new URL(
    `/analysis/${encodeURIComponent(request.market)}/${encodeURIComponent(request.reference)}`,
    webBaseUrl
  );
  target.searchParams.set("documentId", request.documentId);
  return target.toString();
};
