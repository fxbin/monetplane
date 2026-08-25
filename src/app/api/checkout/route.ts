import { NextResponse } from "next/server";
import { resolveApplicationContext } from "@/modules/applications";
import { createCommerceCheckout } from "@/modules/commerce/checkout";

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const context = await resolveApplicationContext(request);

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

    if (
      !externalCustomerId ||
      !providerConnectionId ||
      !successUrl ||
      !cancelUrl
    ) {
      return NextResponse.json(
        {
          error:
            "externalCustomerId, providerConnectionId, successUrl, and cancelUrl are required",
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
    const name = error instanceof Error ? error.name : "";
    if (
      name === "InvalidApplicationCredentialError" ||
      name === "ApplicationContextNotFoundError"
    ) {
      return NextResponse.json(
        {
          error: error instanceof Error ? error.message : "Unauthorized",
          code: "unauthorized",
        },
        { status: 401 },
      );
    }
    if (name === "CommerceCustomerNotFoundError") {
      return NextResponse.json(
        { error: "Customer not found", code: "invalid_state" },
        { status: 404 },
      );
    }
    if (name === "CommerceCatalogError") {
      return NextResponse.json(
        {
          error: error instanceof Error ? error.message : "Catalog error",
          code: "invalid_state",
        },
        { status: 400 },
      );
    }
    if (name === "CommerceProviderConnectionError") {
      return NextResponse.json(
        { error: "Provider connection not found", code: "invalid_state" },
        { status: 400 },
      );
    }
    if (name === "UnsupportedProviderCapabilityError") {
      return NextResponse.json(
        {
          error:
            error instanceof Error ? error.message : "Unsupported capability",
          code: "unsupported_capability",
        },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { error: "Failed to create checkout" },
      { status: 500 },
    );
  }
}
