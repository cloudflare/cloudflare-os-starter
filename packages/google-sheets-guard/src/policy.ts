import type { SpreadsheetRange, SpreadsheetValueMode } from "./types.js";

export const SHEETS_RESOURCE_PATTERN =
  "https://docs.google.com/spreadsheets/d/:spreadsheetId/*";

const SPREADSHEET_ID = /^[A-Za-z0-9_-]{20,}$/;
const BOUNDED_RANGE =
  /^'(?<sheet>[^']+)'!(?<startColumn>[A-Z]+)(?<startRow>[1-9][0-9]*):(?<endColumn>[A-Z]+)(?<endRow>[1-9][0-9]*)$/;
const MAX_APPROVED_CELLS = 1_000;

export type GuardEnv = {
  P3_SPREADSHEET_ID?: string;
  P3_ALLOWED_RANGE?: string;
};

export type GuardConfig = {
  spreadsheetId: string;
  allowedRange: string;
  approvedCells: number;
};

export type GuardConnectOptions = {
  scopes?: "auth" | "full";
  resourceUrlPatterns?: string[];
};

export type ObservationQueue = {
  authorizeObservation(description: { title: string; description: string }): Promise<void>;
  [Symbol.dispose]?(): void;
};

export type UpstreamReader = {
  readRange(
    range: string,
    options?: { valueMode?: SpreadsheetValueMode },
  ): Promise<SpreadsheetRange>;
  [Symbol.dispose]?(): void;
};

function columnNumber(column: string): number {
  let result = 0;
  for (const character of column) {
    result = result * 26 + character.charCodeAt(0) - 64;
  }
  return result;
}

export function parseGuardConfig(env: GuardEnv): GuardConfig {
  const spreadsheetId = env.P3_SPREADSHEET_ID;
  if (!spreadsheetId || !SPREADSHEET_ID.test(spreadsheetId)) {
    throw new Error("P3_SPREADSHEET_ID must be one exact Google spreadsheet ID.");
  }
  const allowedRange = env.P3_ALLOWED_RANGE;
  const match = allowedRange?.match(BOUNDED_RANGE);
  if (!allowedRange || !match?.groups) {
    throw new Error("P3_ALLOWED_RANGE must be one quoted-sheet bounded A1 range.");
  }
  const startColumn = columnNumber(match.groups.startColumn);
  const endColumn = columnNumber(match.groups.endColumn);
  const startRow = Number(match.groups.startRow);
  const endRow = Number(match.groups.endRow);
  if (![startColumn, endColumn, startRow, endRow].every(Number.isSafeInteger)) {
    throw new Error("P3_ALLOWED_RANGE row and column bounds must be safe integers.");
  }
  if (endColumn < startColumn || endRow < startRow) {
    throw new Error("P3_ALLOWED_RANGE must run from top-left to bottom-right.");
  }
  const approvedCells = (endColumn - startColumn + 1) * (endRow - startRow + 1);
  if (!Number.isSafeInteger(approvedCells) || approvedCells > MAX_APPROVED_CELLS) {
    throw new Error(`P3_ALLOWED_RANGE may contain at most ${MAX_APPROVED_CELLS} cells.`);
  }
  return { spreadsheetId, allowedRange, approvedCells };
}

export function parseApprovedSpreadsheetUrl(url: string, expectedId: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Google Sheets resource must be an absolute URL.");
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "docs.google.com" ||
      parsed.search || parsed.hash) {
    throw new Error("Google Sheets resource must be an exact HTTPS URL without query or fragment.");
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length !== 4 || segments[0] !== "spreadsheets" ||
      segments[1] !== "d" || segments[3] !== "edit") {
    throw new Error("Google Sheets resource URL has an invalid path.");
  }
  const spreadsheetId = segments[2];
  if (spreadsheetId !== expectedId) {
    throw new Error("Google Sheets resource does not match P3_SPREADSHEET_ID.");
  }
  return spreadsheetId;
}

export function normalizeConnectOptions(options?: GuardConnectOptions): Required<GuardConnectOptions> {
  if (options?.scopes === "auth") {
    throw new Error("The OM OS Google Sheets guard cannot be used for sign-in.");
  }
  if (options?.resourceUrlPatterns &&
      (options.resourceUrlPatterns.length !== 1 ||
       options.resourceUrlPatterns[0] !== SHEETS_RESOURCE_PATTERN)) {
    throw new Error("The OM OS Google Sheets guard permits only the Google Spreadsheet resource.");
  }
  return { scopes: "full", resourceUrlPatterns: [SHEETS_RESOURCE_PATTERN] };
}

export async function readAfterAuthorization(
  approvalQueue: ObservationQueue,
  upstream: UpstreamReader,
  config: GuardConfig,
  options?: { valueMode?: SpreadsheetValueMode },
): Promise<SpreadsheetRange> {
  await approvalQueue.authorizeObservation({
    title: `Read approved Google Sheets range ${config.allowedRange}`,
    description:
      `Read ${config.approvedCells.toLocaleString()} cell(s) from the single ` +
      "deployment-approved spreadsheet range.",
  });
  return upstream.readRange(config.allowedRange, options);
}
