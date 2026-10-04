/** POSIX single-quote escaping for building shell command strings. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Names safe to interpolate unquoted (docker ids, table names, branches). */
export const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/;
export const SAFE_IDENT =
  /^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*)?$/;
