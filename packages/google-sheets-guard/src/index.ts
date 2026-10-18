import {
  RpcStub,
  RpcTarget,
} from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type {
  ApprovalQueue,
  Gatekeeper,
  GatekeeperConnectCallback,
  GatekeeperConnectOptions,
  GatekeeperUser,
  ResourceConfiguratorFrame,
  ResourceDescription,
  SupportedResource,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import googleWorker, {
  GatekeeperVendor as UpstreamVendor,
  GatekeeperUserImpl as UpstreamUser,
  GoogleSheetsGatekeeperImpl as UpstreamSheetsGatekeeper,
  GoogleVerifier,
  UserAccount,
} from "../../../cloudflare-os/packages/gatekeeper-google/src/google";
import type {
  GoogleSpreadsheetSession,
  SpreadsheetInfo,
  SpreadsheetValueMode,
} from "../../../cloudflare-os/packages/gatekeeper-google/src/sheets-types";
import type {
  GuardedGoogleSheetSession,
  SpreadsheetRange,
} from "./types.js";
import TYPES_CODE from "./types-code.js";
import {
  normalizeConnectOptions,
  parseApprovedSpreadsheetUrl,
  parseGuardConfig,
  readAfterAuthorization,
  SHEETS_RESOURCE_PATTERN,
} from "./policy.js";
import type {
  GuardConfig,
  GuardEnv,
  ObservationQueue,
  UpstreamReader,
} from "./policy.js";

export {
  normalizeConnectOptions,
  parseApprovedSpreadsheetUrl,
  parseGuardConfig,
  readAfterAuthorization,
  SHEETS_RESOURCE_PATTERN,
} from "./policy.js";

export { GoogleVerifier, UserAccount };
export default googleWorker;

const SHEETS_RESOURCE: SupportedResource = {
  urlPattern: SHEETS_RESOURCE_PATTERN,
  title: "OM OS guarded Google Spreadsheet",
  description: "Read one deployment-approved range from one deployment-approved spreadsheet.",
  grantable: true,
};

@validateRpc()
export class GuardedGoogleSheetSessionImpl extends RpcTarget
    implements GuardedGoogleSheetSession, GoogleSpreadsheetSession {
  constructor(
    private readonly approvalQueue: ObservationQueue,
    private readonly upstream: UpstreamReader,
    private readonly config: GuardConfig,
  ) {
    super();
  }

  async readApprovedRange(
    options?: { valueMode?: SpreadsheetValueMode },
  ): Promise<SpreadsheetRange> {
    return readAfterAuthorization(this.approvalQueue, this.upstream, this.config, options);
  }

  async getSpreadsheet(): Promise<SpreadsheetInfo> {
    throw new Error("Spreadsheet metadata discovery is disabled by the OM OS P3 guard.");
  }

  async readRange(
    _range: string,
    _options?: { valueMode?: SpreadsheetValueMode },
  ): Promise<SpreadsheetRange> {
    throw new Error("Arbitrary ranges are disabled. Use readApprovedRange().");
  }

  async readRanges(
    _ranges: string[],
    _options?: { valueMode?: SpreadsheetValueMode },
  ): Promise<SpreadsheetRange[]> {
    throw new Error("Arbitrary ranges are disabled. Use readApprovedRange().");
  }

  [Symbol.dispose](): void {
    this.approvalQueue[Symbol.dispose]?.();
    this.upstream[Symbol.dispose]?.();
  }
}

@validateRpc()
export class GoogleSheetsGatekeeperImpl extends UpstreamSheetsGatekeeper
    implements Gatekeeper<GuardedGoogleSheetSession> {
  async describe(): Promise<ResourceDescription> {
    const config = parseGuardConfig(this.env as GuardEnv);
    return {
      url: `https://docs.google.com/spreadsheets/d/${config.spreadsheetId}/edit`,
      title: "OM OS P3 approved Google Spreadsheet",
      snippet: `Read-only; fixed range ${config.allowedRange}`,
      suggestedBindingName: "P3_GOOGLE_SHEET",
      tsType: "GuardedGoogleSheetSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async startSession(
    approvalQueue: RpcStub<ApprovalQueue>,
  ): Promise<GuardedGoogleSheetSession & GoogleSpreadsheetSession> {
    const config = parseGuardConfig(this.env as GuardEnv);
    // Keep upstream's own observation record as defense in depth. The wrapper performs the first
    // authorization before invoking the upstream API, so no remote read occurs if it is denied.
    const upstream = await super.startSession(approvalQueue.dup());
    return new GuardedGoogleSheetSessionImpl(approvalQueue.dup(), upstream, config);
  }
}

@validateRpc()
export class GatekeeperUserImpl extends UpstreamUser implements GatekeeperUser {
  async getSupportedResources(): Promise<SupportedResource[]> {
    return [SHEETS_RESOURCE];
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<GuardedGoogleSheetSession>>;
    resource: SupportedResource;
  }> {
    const config = parseGuardConfig(this.env as GuardEnv);
    const spreadsheetId = parseApprovedSpreadsheetUrl(url, config.spreadsheetId);
    const userObjectId = (this.ctx.props as { userObjectId: string }).userObjectId;
    return {
      class: this.ctx.exports.GoogleSheetsGatekeeperImpl({
        props: { userObjectId, spreadsheetId },
      }),
      resource: SHEETS_RESOURCE,
    };
  }

  startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error(
      "Resource search is disabled. Paste the exact deployment-approved Google Spreadsheet URL.",
    );
  }

  async ensureResources(resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    if (resourceUrlPatterns.length !== 1 || resourceUrlPatterns[0] !== SHEETS_RESOURCE_PATTERN) {
      throw new Error("Only the Google Spreadsheet resource can be authorized.");
    }
    return super.ensureResources([SHEETS_RESOURCE_PATTERN]);
  }
}

@validateRpc()
export class GatekeeperVendor extends UpstreamVendor {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Google Sheets (OM OS guarded)",
      url: "https://developers.google.com/sheets/api",
      color: "#e8f0fe",
      tagline: "Read one fixed range from one approved synthetic spreadsheet",
      description:
        "A constrained Cloudflare OS Google Sheets integration. It exposes no write actions, " +
        "uses Cloudflare OS ApprovalQueue before each agent-visible range read, and accepts only " +
        "the deployment-approved spreadsheet and A1 range.",
      providesAuth: false,
    };
  }

  async connectAccount(
    callback: Fetcher<GatekeeperConnectCallback>,
    options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    parseGuardConfig(this.env as GuardEnv);
    return super.connectAccount(callback, normalizeConnectOptions(options));
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [SHEETS_RESOURCE];
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}
