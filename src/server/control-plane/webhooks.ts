import {
  listWebhookDeliveries,
  listWebhookEndpoints,
} from "@/modules/webhooks";
import type { ConsoleContext } from "./context";

/**
 * Read layer for the dashboard webhooks page. The page itself must not
 * import module services directly (enforced by tests/module-boundaries.test.ts).
 */
export async function getWebhookConsoleData(
  applicationId: string,
  context: ConsoleContext,
) {
  const [endpoints, deliveries] = await Promise.all([
    listWebhookEndpoints(applicationId, context.environment),
    listWebhookDeliveries(applicationId, context.environment, { limit: 50 }),
  ]);

  return { endpoints, deliveries };
}
