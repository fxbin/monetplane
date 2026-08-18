import { beforeEach } from "vitest";
import { resetIntegrationDatabase } from "./reset-database";

beforeEach(async () => {
  await resetIntegrationDatabase();
});
