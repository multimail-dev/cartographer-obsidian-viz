/**
 * FTS5 query sanitizer for vault search_notes.
 *
 * SQLite FTS5 barewords may only contain a-zA-Z, 0-9, underscore, and non-ASCII.
 * Hyphens (`-`), colons (`:`), and plus (`+`) terminate barewords and are consumed
 * as grammar operators (column-filter negation, column qualifier, phrase concat).
 * Queries like `fine-tune`, `2026-04-25`, `created:2026` error with
 * "no such column: <left>".
 *
 * This sanitizer wraps problematic bareword tokens in double quotes so the query
 * parser passes them to the tokenizer (unicode61) instead of interpreting them as
 * grammar operators.
 *
 * Does NOT modify: already-quoted phrases, boolean operators (AND/OR/NOT),
 * parentheses, valid column qualifiers (path/title/content/tags), or advanced
 * syntax (^, space-padded +, NEAR(), {col set}:).
 *
 * @see https://sqlite.org/fts5.html#full_text_query_syntax
 */

const BOOLEAN_OPS = new Set(["AND", "OR", "NOT"]);

/**
 * Sanitize a user-provided FTS5 query string.
 *
 * @param query  Raw query from the MCP caller
 * @param columns  Set of real FTS5 column names (lowercase)
 * @returns  Query safe for `WHERE vault_fts MATCH ?`
 */
export function sanitizeFtsQuery(
  query: string,
  columns: ReadonlySet<string>,
): string {
  // Empty / whitespace-only: preserve unchanged (current behaviour)
  if (!query || !query.trim()) return query;

  // Advanced-syntax bypass: if the query uses FTS5 power syntax that our
  // tokenizer doesn't model, pass through verbatim. The caller is expected
  // to manually quote hyphens/colons in these queries.
  if (hasAdvancedSyntax(query)) return query;

  return tokenizeAndSanitize(query, columns);
}

/** Detect FTS5 advanced syntax that the sanitizer doesn't model. */
function hasAdvancedSyntax(query: string): boolean {
  // ^ (initial token operator)
  if (query.includes("^")) return true;
  // Space-padded + (phrase concatenation) — NOT bare + inside tokens like C++
  if (/ \+ /.test(query)) return true;
  // NEAR() group
  if (query.includes("NEAR(")) return true;
  // {column set}: syntax
  if (query.includes("{")) return true;
  return false;
}

/**
 * Tokenize the query respecting quoted phrases and parentheses,
 * then wrap any problematic tokens in double quotes.
 */
function tokenizeAndSanitize(
  query: string,
  columns: ReadonlySet<string>,
): string {
  const result: string[] = [];
  let i = 0;

  while (i < query.length) {
    const ch = query[i];

    // Skip whitespace, emit a single space
    if (/\s/.test(ch)) {
      if (result.length > 0 && result[result.length - 1] !== " ") {
        result.push(" ");
      }
      i++;
      continue;
    }

    // Quoted phrase — pass through verbatim (including the quotes)
    if (ch === '"') {
      const closing = query.indexOf('"', i + 1);
      if (closing === -1) {
        // Unbalanced quote: close at end of string
        result.push(query.slice(i) + '"');
        break;
      }
      // Include any trailing * after the closing quote
      let end = closing + 1;
      if (end < query.length && query[end] === "*") end++;
      result.push(query.slice(i, end));
      i = end;
      continue;
    }

    // Parentheses — pass through as literal grouping operators
    if (ch === "(" || ch === ")") {
      result.push(ch);
      i++;
      continue;
    }

    // Collect a bareword token (everything up to whitespace, quote, or paren)
    let token = "";
    while (i < query.length && !/[\s"()]/.test(query[i])) {
      token += query[i];
      i++;
    }

    if (!token) continue;

    // Boolean operators (case-sensitive uppercase per FTS5)
    if (BOOLEAN_OPS.has(token)) {
      result.push(token);
      continue;
    }

    // Column qualifier: <col>:<rest> where col is a real FTS5 column (case-insensitive)
    const colMatch = token.match(/^([a-zA-Z_]+):(.*)/);
    if (colMatch && columns.has(colMatch[1].toLowerCase())) {
      const col = colMatch[1];
      const rest = colMatch[2];
      result.push(`${col}:${sanitizeToken(rest)}`);
      continue;
    }

    // Negated column qualifier: -<col>:<rest>
    const negColMatch = token.match(/^-([a-zA-Z_]+):(.*)/);
    if (negColMatch && columns.has(negColMatch[1].toLowerCase())) {
      const col = negColMatch[1];
      const rest = negColMatch[2];
      result.push(`-${col}:${sanitizeToken(rest)}`);
      continue;
    }

    // Token contains problematic characters — quote it
    if (needsQuoting(token)) {
      result.push(sanitizeToken(token));
      continue;
    }

    // Plain bareword — pass through
    result.push(token);
  }

  // Trim trailing space
  const joined = result.join("");
  return joined.trimEnd();
}

/** Does this token contain characters that FTS5 would interpret as grammar operators? */
function needsQuoting(token: string): boolean {
  return /[-:+]/.test(token);
}

/**
 * Wrap a single token in double quotes, preserving trailing * for prefix matching.
 * Internal double quotes are doubled (FTS5 escape convention).
 * If the token is empty, return it unchanged.
 * If the token is already fully quoted, return unchanged.
 */
function sanitizeToken(token: string): string {
  if (!token) return token;

  // Already quoted
  if (token.startsWith('"') && (token.endsWith('"') || token.endsWith('"*'))) {
    return token;
  }

  // No problematic characters — pass through
  if (!needsQuoting(token)) return token;

  // Strip trailing * (prefix match operator)
  let hasStar = false;
  let inner = token;
  if (inner.endsWith("*")) {
    hasStar = true;
    inner = inner.slice(0, -1);
  }

  // Double any internal quotes
  inner = inner.replace(/"/g, '""');

  return `"${inner}"${hasStar ? "*" : ""}`;
}
