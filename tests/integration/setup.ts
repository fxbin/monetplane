import { beforeEach } from "vitest";
import { resetIntegrationDatabase } from "./reset-database";

beforeEach(async () => {
  process.env.MONETPLANE_ALLOW_LOCAL_WEBHOOKS = "true";
  await resetIntegrationDatabase();
});
