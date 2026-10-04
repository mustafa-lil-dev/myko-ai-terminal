export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type Method = (typeof METHODS)[number];

export type ApiRequest = {
  method: Method;
  url: string;
  /** One `Name: value` per line. */
  headers: string;
  /** One `key=value` per line. */
  query: string;
  body: string;
};

export function parseKeyValueLines(
  text: string,
  sep: ":" | "=",
): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf(sep);
    if (i <= 0) continue;
    out.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
  }
  return out;
}

export type BuiltRequest = {
  url: string;
  method: Method;
  headers: Record<string, string>;
  body: number[] | null;
};

/** Throws a readable Error for invalid input. */
export function buildRequest(r: ApiRequest): BuiltRequest {
  let u: URL;
  try {
    u = new URL(r.url.trim());
  } catch {
    throw new Error("Invalid URL (include http:// or https://)");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:")
    throw new Error("Only http(s) URLs are supported");
  for (const [k, v] of parseKeyValueLines(r.query, "="))
    u.searchParams.append(k, v);
  const headers: Record<string, string> = {};
  for (const [k, v] of parseKeyValueLines(r.headers, ":")) headers[k] = v;
  let body: number[] | null = null;
  if (r.method !== "GET" && r.body.trim()) {
    const hasCt = Object.keys(headers).some(
      (h) => h.toLowerCase() === "content-type",
    );
    const trimmed = r.body.trim();
    if (!hasCt && /^[[{]/.test(trimmed)) {
      try {
        JSON.parse(trimmed);
      } catch (e) {
        throw new Error(`Body is not valid JSON: ${(e as Error).message}`);
      }
      headers["Content-Type"] = "application/json";
    }
    body = Array.from(new TextEncoder().encode(r.body));
  }
  return { url: u.toString(), method: r.method, headers, body };
}

const SENSITIVE_HEADER =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-csrf-token|api-key)$/i;

export function redactHeaders(
  h: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(h).map(([k, v]) => [
      k,
      SENSITIVE_HEADER.test(k) ? "<REDACTED>" : v,
    ]),
  );
}

export type ApiResult = {
  status: number;
  headers: Record<string, string>;
  body: string;
  ms: number;
  bytes: number;
};

export function prettyBody(
  body: string,
  headers: Record<string, string>,
): string {
  const ct =
    Object.entries(headers).find(
      ([k]) => k.toLowerCase() === "content-type",
    )?.[1] ?? "";
  if (ct.includes("json") || /^[[{]/.test(body.trim())) {
    try {
      return JSON.stringify(JSON.parse(body), null, 2);
    } catch {}
  }
  return body;
}

export function buildFailurePrompt(
  req: BuiltRequest,
  res: ApiResult | null,
  error: string | null,
  redact: (s: string) => string,
): string {
  const reqBody = req.body
    ? new TextDecoder().decode(new Uint8Array(req.body))
    : "";
  const head = `<myko-api-failure>
Request: ${req.method} ${redact(req.url)}
Request headers: ${JSON.stringify(redactHeaders(req.headers))}
Request body: ${redact(reqBody.slice(0, 4000)) || "(none)"}
${res ? `Response: ${res.status} in ${res.ms}ms\nResponse headers: ${JSON.stringify(redactHeaders(res.headers))}\nResponse body: ${redact(res.body.slice(0, 6000))}` : `Error: ${redact(error ?? "unknown")}`}
</myko-api-failure>`;
  return `${head}

Explain why this request failed. Then look for the handler in this project (use grep/read_file sparingly, never secret files) and point to the likely cause with file and line. Do not modify anything unless I ask.`;
}
