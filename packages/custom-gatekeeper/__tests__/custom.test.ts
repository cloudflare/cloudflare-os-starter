import { describe, expect, it } from "vitest";
import {
  CustomSessionImpl,
  describeCustomAccount,
  describeCustomVendor,
} from "../src/custom.js";

describe("custom-gatekeeper", () => {
  it("describes an auto-provisioned singleton", () => {
    expect(describeCustomVendor()).toMatchObject({
      displayName: "Custom Gatekeeper",
      autoProvisionsAccount: true,
      providesAuth: false,
    });
    expect(describeCustomAccount()).toMatchObject({
      displayName: "Custom Gatekeeper",
      singleton: { tsType: "CustomSession" },
    });
  });

  it("authorizes the observation before returning deployment information", async () => {
    let observation: unknown;
    let disposed = false;
    const session = new CustomSessionImpl(
      {
        authorizeObservation(value: unknown) {
          observation = value;
          return Promise.resolve();
        },
        [Symbol.dispose]() {
          disposed = true;
        },
      },
      { name: "Acme", message: "Use the internal handbook." },
    );

    await expect(session.getDeploymentInfo()).resolves.toEqual({
      name: "Acme",
      message: "Use the internal handbook.",
    });
    expect(observation).toEqual({
      title: "Read deployment information",
      description: "Read the custom information configured by this deployment.",
      subresources: [],
    });

    session[Symbol.dispose]();
    expect(disposed).toBe(true);
  });
});
