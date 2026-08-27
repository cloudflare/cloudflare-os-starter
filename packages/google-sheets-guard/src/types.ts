export type SpreadsheetCellValue = string | number | boolean | null;

export type SpreadsheetValueMode = "formatted" | "raw" | "formula";

export type SpreadsheetRange = {
  range: string;
  values: SpreadsheetCellValue[][];
};

/** Read-only access to the single A1 range approved by the OM OS deployment. */
export interface GuardedGoogleSheetSession {
  /**
   * Read the deployment-approved range. The spreadsheet ID and A1 range are fixed outside the
   * agent-visible API; callers cannot provide or expand either value.
   */
  readApprovedRange(options?: { valueMode?: SpreadsheetValueMode }): Promise<SpreadsheetRange>;
}
