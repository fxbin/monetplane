import { NextResponse } from "next/server";
import { resolveCredentialApplicationContext } from "@/modules/applications";
import { createCommerceCheckout } from "@/modules/commerce/checkout";
import { sdkRouteError } from "@/server/control-plane/sdk-route-errors";

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const context = await resolveCredentialApplicationContext(request);

    const externalCustomerId =
      typeof body.externalCustomerId === "string"
        ? body.externalCustomerId.trim()
        : "";
    const providerConnectionId =
      typeof body.providerConnectionId === "string"
        ? body.providerConnectionId.trim()
        : "";
    const successUrl =
      typeof body.successUrl === "string" ? body.successUrl.trim() : "";
    const cancelUrl =
      typeof body.cancelUrl === "string" ? body.cancelUrl.trim() : "";

    if (!externalCustomerId || !successUrl || !cancelUrl) {
      return NextResponse.json(
        {
          error: "externalCustomerId, successUrl, and cancelUrl are required",
        },
        { status: 400 },
      );
    }

    const itemsRaw = Array.isArray(body.items) ? body.items : [];
    if (itemsRaw.length === 0) {
      return NextResponse.json(
        { error: "At least one checkout item is required" },
        { status: 400 },
      );
    }

    const environment =
      body.environment === "test" || body.environment === "live"
        ? body.environment
        : undefined;

    const items = itemsRaw.map((item, i) => {
      const obj = item as Record<string, unknown>;
      const priceId = typeof obj.priceId === "string" ? obj.priceId.trim() : "";
      const quantity = typeof obj.quantity === "number" ? obj.quantity : 0;
      if (!priceId || !Number.isSafeInteger(quantity) || quantity < 1) {
        throw new Error(`Invalid item at index ${i}`);
      }
      return { priceId, quantity };
    });

    const result = await createCommerceCheckout(context.application.id, {
      externalCustomerId,
      providerConnectionId,
      items,
      successUrl,
      cancelUrl,
      environment,
    });

    return NextResponse.json(
      {
        orderId: result.orderId,
        checkoutSessionId: result.checkoutSessionId,
        checkoutUrl: result.checkoutUrl,
        providerCheckoutId: result.providerCheckoutId,
        orderStatus: result.orderStatus,
      },
      { status: 201 },
    );
  } catch (error) {
    return sdkRouteError(error, "Failed to create checkout");
  }
}
