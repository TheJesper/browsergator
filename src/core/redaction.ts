const SENSITIVE_KEY = /(?:^|[-_])(authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|password|passwd|secret|token|api[-_]?key|bankid|session[-_]?id)(?:$|[-_])/i;

export const REDACTED = '[REDACTED]';

export function redactHeaders(
  headers: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!headers) return undefined;
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, SENSITIVE_KEY.test(key) ? REDACTED : value])
  );
}

export function redact<T>(value: T): T {
  return redactValue(value, new WeakSet<object>()) as T;
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, seen));
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) {
      output[key] = REDACTED;
    } else if (/headers/i.test(key) && entry && typeof entry === 'object' && !Array.isArray(entry)) {
      output[key] = redactHeaders(entry as Record<string, unknown>);
    } else if (/postData|requestBody|responseBody|payloadData/i.test(key)) {
      output[key] = '[OMITTED]';
    } else {
      output[key] = redactValue(entry, seen);
    }
  }
  return output;
}

function redactString(value: string): string {
  return value
    .replace(
      /\b(authorization|password|passwd|secret|token|api[-_]?key|cookie)\s*([:=])\s*((?:Bearer\s+)?[^\s,;&]+)/gi,
      '$1$2[REDACTED]'
    )
    .replace(/\bBearer\s+[/A-Za-z0-9._~+-]+=*/gi, 'Bearer [REDACTED]');
}
