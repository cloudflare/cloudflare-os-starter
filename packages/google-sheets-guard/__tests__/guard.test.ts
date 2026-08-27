import { describe, expect, it, vi } from "vitest";
import {
  GatekeeperUserImpl,
  GatekeeperVendor,
  GoogleSheetsGatekeeperImpl,
  GuardedGoogleSheetSessionImpl,
} from "../src/index.js";
import {
  normalizeConnectOptions,
  parseApprovedSpreadsheetUrl,
  parseGuardConfig,
  readAfterAuthorization,
  SHEETS_RESOURCE_PATTERN,
} from "../src/policy.js";

const SPREADSHEET_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";

function env(overrides: Record<string, string | undefined> = {}) {
  return {
    P3_SPREADSHEET_ID: SPREADSHEET_ID,
    P3_ALLOWED_RANGE: "'P3_READONLY'!A1:D20",
    ...overrides,
  } as Cloudflare.Env & {
    P3_SPREADSHEET_ID?: string;
    P3_ALLOWED_RANGE?: string;
  };
}

describe("P3 Google Sheets guard", () => {
  it("accepts one exact spreadsheet and bounded range", () => {
    expect(parseGuardConfig(env())).toEqual({
      spreadsheetId: SPREADSHEET_ID,
      allowedRange: "'P3_READONLY'!A1:D20",
      approvedCells: 80,
    });
  });

  it.each([
    ["missing id", { P3_SPREADSHEET_ID: undefined }],
    ["wildcard id", { P3_SPREADSHEET_ID: "*" }],
    ["unbounded range", { P3_ALLOWED_RANGE: "'P3_READONLY'!A:D" }],
    ["reversed range", { P3_ALLOWED_RANGE: "'P3_READONLY'!D20:A1" }],
    ["too many cells", { P3_ALLOWED_RANGE: "'P3_READONLY'!A1:Z100" }],
    ["unsafe row", { P3_ALLOWED_RANGE: "'P3_READONLY'!A9007199254740992:A9007199254740992" }],
    ["unsafe column", {
      P3_ALLOWED_RANGE: "'P3_READONLY'!ZZZZZZZZZZZZZZZZZZZZ1:ZZZZZZZZZZZZZZZZZZZZ1",
    }],
  ])("rejects %s", (_name, overrides) => {
    expect(() => parseGuardConfig(env(overrides))).toThrow();
  });

  it("accepts 1,000 cells and rejects 1,001", () => {
    expect(parseGuardConfig(env({ P3_ALLOWED_RANGE: "'P3_READONLY'!A1:J100" })))
      .toMatchObject({ approvedCells: 1_000 });
    expect(() => parseGuardConfig(env({ P3_ALLOWED_RANGE: "'P3_READONLY'!A1:A1001" })))
      .toThrow(/at most 1000 cells/);
  });

  it("accepts only the exact approved spreadsheet URL", () => {
    expect(parseApprovedSpreadsheetUrl(
      `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`,
      SPREADSHEET_ID,
    )).toBe(SPREADSHEET_ID);
    expect(() => parseApprovedSpreadsheetUrl(
      "https://docs.google.com/spreadsheets/d/anotherSpreadsheetIdentifier/edit",
      SPREADSHEET_ID,
    )).toThrow(/does not match/);
    expect(() => parseApprovedSpreadsheetUrl(
      `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit?gid=0`,
      SPREADSHEET_ID,
    )).toThrow(/without query/);
    expect(() => parseApprovedSpreadsheetUrl(
      `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/copy`,
      SPREADSHEET_ID,
    )).toThrow(/invalid path/);
  });

  it("normalizes OAuth to the Sheets resource only", () => {
    expect(normalizeConnectOptions()).toEqual({
      scopes: "full",
      resourceUrlPatterns: [SHEETS_RESOURCE_PATTERN],
    });
    expect(() => normalizeConnectOptions({ scopes: "auth" })).toThrow(/cannot be used for sign-in/);
    expect(() => normalizeConnectOptions({
      resourceUrlPatterns: ["https://mail.google.com/*"],
    })).toThrow(/only the Google Spreadsheet/);
  });

  it("authorizes before invoking the upstream read", async () => {
    const order: string[] = [];
    const approvalQueue = {
      authorizeObservation: vi.fn(async () => { order.push("authorize"); }),
    };
    const upstream = {
      readRange: vi.fn(async (range: string) => {
        order.push(`read:${range}`);
        return { range, values: [["synthetic"]] };
      }),
    };
    await readAfterAuthorization(approvalQueue, upstream, parseGuardConfig(env()));
    expect(order).toEqual(["authorize", "read:'P3_READONLY'!A1:D20"]);
  });

  it("does not read upstream when pre-authorization fails", async () => {
    const upstream = { readRange: vi.fn() };
    await expect(readAfterAuthorization(
      { authorizeObservation: vi.fn(async () => { throw new Error("denied"); }) },
      upstream,
      parseGuardConfig(env()),
    )).rejects.toThrow("denied");
    expect(upstream.readRange).not.toHaveBeenCalled();
  });

  it("blocks the inherited agent-visible session methods at runtime", async () => {
    const session = new GuardedGoogleSheetSessionImpl(
      { authorizeObservation: vi.fn(async () => undefined) },
      { readRange: vi.fn() },
      parseGuardConfig(env()),
    );
    await expect(session.getSpreadsheet()).rejects.toThrow(/metadata discovery is disabled/);
    await expect(session.readRange("'OTHER'!A1:A2")).rejects.toThrow(/Arbitrary ranges/);
    await expect(session.readRanges(["'OTHER'!A1:A2"])).rejects.toThrow(/Arbitrary ranges/);
  });

  it("keeps the inherited Sheets action surface read-only", async () => {
    const gatekeeper = Object.create(GoogleSheetsGatekeeperImpl.prototype) as
      GoogleSheetsGatekeeperImpl;
    await expect(gatekeeper.getAutoApprovableActions()).resolves.toEqual([]);
    await expect(gatekeeper.applyAction(1)).rejects.toThrow(/read-only/);
    await expect(gatekeeper.rejectAction(1)).rejects.toThrow(/read-only/);
    expect(() => gatekeeper.revertAction(1)).toThrow(/read-only/);
  });

  it("rejects sign-in and resource discovery through the actual wrapper classes", async () => {
    const vendorDescription = await GatekeeperVendor.prototype.describe.call(
      {} as GatekeeperVendor,
    );
    expect(vendorDescription.providesAuth).toBe(false);
    expect(() => GatekeeperUserImpl.prototype.startResourceConfigurator.call(
      {} as GatekeeperUserImpl,
      SHEETS_RESOURCE_PATTERN,
    )).toThrow(/Resource search is disabled/);
    await expect(GatekeeperUserImpl.prototype.ensureResources.call(
      {} as GatekeeperUserImpl,
      ["https://mail.google.com/*"],
    )).rejects.toThrow(/Only the Google Spreadsheet/);
  });

  it("uses the fixed deployment resource in the actual Gatekeeper description", async () => {
    const description = await GoogleSheetsGatekeeperImpl.prototype.describe.call({
      env: env(),
    } as unknown as GoogleSheetsGatekeeperImpl);
    expect(description).toMatchObject({
      url: `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`,
      snippet: "Read-only; fixed range 'P3_READONLY'!A1:D20",
      tsType: "GuardedGoogleSheetSession",
    });
  });

  it("denies before the actual inherited session can reach Google", async () => {
    const denied = new Error("pre-authorization denied");
    const approvalQueue = {
      dup() { return this; },
      authorizeObservation: vi.fn(async () => { throw denied; }),
      [Symbol.dispose]() {},
    };
    const session = await GoogleSheetsGatekeeperImpl.prototype.startSession.call({
      env: env(),
      ctx: { props: { userObjectId: "test-user", spreadsheetId: SPREADSHEET_ID } },
    } as unknown as GoogleSheetsGatekeeperImpl, approvalQueue as never);
    await expect(session.readApprovedRange()).rejects.toBe(denied);
  });
});
