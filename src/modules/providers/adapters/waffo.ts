import { createHash } from "node:crypto";
import {
  Environment,
  Waffo,
  WaffoError,
  WaffoUnknownStatusError,
} from "@waffo/waffo-node";
import type {
  CancelSubscriptionInput,
  CheckoutResult,
  NormalizedPayment,
  NormalizedProviderEvent,
  NormalizedRefund,
  NormalizedSubscription,
  PaymentProviderAdapter,
  ProviderCapabilities,
  ProviderConnectionContext,
  RefundPaymentInput,
  UpdateSubscriptionInput,
  VerifiedWebhook,
  VerifyWebhookInput,
} from "../contract";
import {
  InvalidProviderWebhookSignatureError,
  ProviderOperationError,
} from "../contract";

const WAFFO_CAPABILITIES: ProviderCapabilities = {
  one_time_checkout: true,
  recurring_subscription: true,
  monthly_interval: true,
  annual_interval: true,
  weekly_interval: false,
  trial_periods: false,
  refund: true,
  subscription_cancel: true,
  subscription_update: false,
  customer_portal: false,
  provider_hosted_checkout: true,
};

type JsonRecord = Record<string, unknown>;

type WaffoResource = {
  create?: (params: JsonRecord) => Promise<unknown>;
  inquiry?: (params: JsonRecord) => Promise<unknown>;
  cancel?: (params: JsonRecord) => Promise<unknown>;
  refund?: (params: JsonRecord) => Promise<unknown>;
};

type WaffoClientLike = {
  order(): WaffoResource;
  subscription(): WaffoResource;
  merchantConfig(): WaffoResource;
  webhook(): {
    verifySignature(body: string, signature: string): boolean;
  };
};

type WaffoAdapterOptions = {
  clientFactory?: (connection: ProviderConnectionContext) => WaffoClientLike;
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function recordValue(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function headerValue(
  headers: Readonly<Record<string, string | undefined>>,
  target: string,
): string | undefined {
  const direct = headers[target];
  if (direct) return direct;
  const normalizedTarget = target.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === normalizedTarget && value) return value;
  }
  return undefined;
}

function requiredCredential(
  connection: ProviderConnectionContext,
  key: string,
): string {
  const value = connection.credentials[key]?.trim();
  if (!value) {
    throw new ProviderOperationError(
      `Waffo connection configuration ${key} is required. Replace this connection's legacy credentials before retrying.`,
      "rejected",
    );
  }
  return value;
}

function createSdkClient(
  connection: ProviderConnectionContext,
): WaffoClientLike {
  return new Waffo({
    apiKey: requiredCredential(connection, "apiKey"),
    privateKey: requiredCredential(connection, "privateKey"),
    waffoPublicKey: requiredCredential(connection, "waffoPublicKey"),
    merchantId: requiredCredential(connection, "merchantId"),
    environment:
      connection.mode === "test" ? Environment.SANDBOX : Environment.PRODUCTION,
  }) as unknown as WaffoClientLike;
}

function clientFor(
  connection: ProviderConnectionContext,
  options: WaffoAdapterOptions,
): WaffoClientLike {
  return options.clientFactory?.(connection) ?? createSdkClient(connection);
}

function responseMethod<T>(
  response: unknown,
  method: string,
): (() => T) | undefined {
  if (!isRecord(response)) return undefined;
  const value = response[method];
  return typeof value === "function"
    ? (value as () => T).bind(response)
    : undefined;
}

function unwrapResponse(response: unknown, operation: string): JsonRecord {
  const isSuccess = responseMethod<boolean>(response, "isSuccess");
  const getData = responseMethod<unknown>(response, "getData");
  if (!isSuccess || !getData) {
    throw new ProviderOperationError(
      `Waffo ${operation} returned an invalid SDK response`,
      "outcome_uncertain",
    );
  }
  if (!isSuccess()) {
    const getCode = responseMethod<unknown>(response, "getCode");
    const getMessage =
      responseMethod<unknown>(response, "getMessage") ??
      responseMethod<unknown>(response, "getMsg");
    const code = stringValue(getCode?.());
    const message = stringValue(getMessage?.());
    throw new ProviderOperationError(
      [message ?? `Waffo rejected ${operation}`, code ? `(code ${code})` : ""]
        .filter(Boolean)
        .join(" "),
      "rejected",
    );
  }

  const data = getData();
  if (!isRecord(data)) {
    throw new ProviderOperationError(
      `Waffo ${operation} succeeded without a response object`,
      "outcome_uncertain",
    );
  }
  return data;
}

function sdkErrorMessage(error: WaffoError | WaffoUnknownStatusError): string {
  return error.message || error.name || "Waffo SDK operation failed";
}

function rethrowSdkError(error: unknown, mutation: boolean): never {
  if (error instanceof ProviderOperationError) throw error;
  if (error instanceof WaffoUnknownStatusError) {
    throw new ProviderOperationError(
      sdkErrorMessage(error),
      "outcome_uncertain",
    );
  }
  if (error instanceof WaffoError) {
    const code = String(error.errorCode ?? "");
    const failureKind =
      mutation && ["S0002", "S0004", "S0006"].includes(code)
        ? "outcome_uncertain"
        : "rejected";
    throw new ProviderOperationError(sdkErrorMessage(error), failureKind);
  }
  throw error;
}

async function sdkCall<T>(
  mutation: boolean,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    rethrowSdkError(error, mutation);
  }
}

function compactRequestId(prefix: string, value: string): string {
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 24);
  return `${prefix}_${digest}`.slice(0, 32);
}

function amountString(amountMinor: number): string {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    throw new ProviderOperationError(
      "Waffo amount must be a non-negative safe integer in minor units",
      "rejected",
    );
  }
  return (amountMinor / 100).toFixed(2);
}

function actionUrl(value: unknown): string | undefined {
  const direct = stringValue(value);
  if (!direct) return undefined;
  if (/^https?:\/\//i.test(direct)) return direct;
  try {
    const parsed = JSON.parse(direct) as unknown;
    const record = recordValue(parsed);
    return stringValue(record?.webUrl ?? record?.url ?? record?.checkoutUrl);
  } catch {
    return undefined;
  }
}

function timestampValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return undefined;
}

function centsFromAmount(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value * 100);
  }
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.round(parsed * 100);
}

function mapPaymentStatus(value: unknown): NormalizedPayment["status"] {
  switch (value) {
    case "PAY_SUCCESS":
      return "succeeded";
    case "ORDER_CLOSE":
    case "PAY_FAILED":
    case "FAILED":
      return "failed";
    case "ORDER_FULLY_REFUNDED":
      return "refunded";
    default:
      return "pending";
  }
}

function mapRefundStatus(value: unknown): NormalizedRefund["status"] {
  switch (value) {
    case "ORDER_FULLY_REFUNDED":
      return "succeeded";
    case "ORDER_REFUND_FAILED":
      return "failed";
    default:
      return "pending";
  }
}

function mapSubscriptionStatus(
  value: unknown,
): NormalizedSubscription["status"] {
  switch (value) {
    case "ACTIVE":
      return "active";
    case "MERCHANT_CANCELLED":
    case "USER_CANCELLED":
    case "CHANNEL_CANCELLED":
      return "cancelled";
    case "EXPIRED":
    case "CLOSE":
      return "expired";
    default:
      return "pending";
  }
}

function userIdFrom(value: JsonRecord): string | undefined {
  return stringValue(recordValue(value.userInfo)?.userId);
}

function normalizePaymentObject(value: JsonRecord): NormalizedPayment {
  const providerPaymentId =
    stringValue(value.acquiringOrderId) ??
    stringValue(value.paymentRequestId) ??
    stringValue(value.merchantOrderId);
  if (!providerPaymentId) {
    throw new Error("Waffo payment response is missing an order identifier");
  }
  return {
    providerPaymentId,
    status: mapPaymentStatus(value.orderStatus),
    amountMinor:
      centsFromAmount(value.orderAmount) ?? numberValue(value.amountMinor) ?? 0,
    currency: stringValue(value.orderCurrency) ?? "USD",
    providerCustomerId: userIdFrom(value),
  };
}

function normalizeSubscriptionObject(
  value: JsonRecord,
): NormalizedSubscription {
  const providerSubscriptionId = stringValue(value.subscriptionId);
  if (!providerSubscriptionId) {
    throw new Error("Waffo subscription response is missing subscriptionId");
  }
  const productInfo = recordValue(value.productInfo);
  return {
    providerSubscriptionId,
    status: mapSubscriptionStatus(value.subscriptionStatus),
    providerCustomerId: userIdFrom(value),
    currentPeriodStart: timestampValue(
      productInfo?.startDateTime ?? value.startDateTime,
    ),
    currentPeriodEnd: timestampValue(
      productInfo?.nextPaymentDateTime ??
        productInfo?.endDateTime ??
        value.nextPaymentDateTime,
    ),
    cancelAtPeriodEnd: false,
  };
}

function parseWebhook(input: VerifiedWebhook): {
  providerEventId: string;
  providerEventName: string;
  occurredAt: string;
  result: JsonRecord;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawBody) as unknown;
  } catch {
    throw new Error("Waffo webhook body is not valid JSON");
  }
  if (!isRecord(parsed)) throw new Error("Waffo webhook must be a JSON object");
  const result = recordValue(parsed.result ?? parsed.data);
  const providerEventName = stringValue(parsed.eventType ?? parsed.type);
  if (!providerEventName || !result) {
    throw new Error("Waffo webhook is missing required event fields");
  }
  const occurredAt =
    timestampValue(
      parsed.eventTime ??
        result.orderUpdatedAt ??
        result.refundUpdatedAt ??
        result.updatedAt ??
        result.requestedAt,
    ) ?? new Date(0).toISOString();
  const explicitId =
    stringValue(parsed.eventId) ??
    stringValue(parsed.notificationId) ??
    stringValue(parsed.id);
  const bodyHash = createHash("sha256")
    .update(input.rawBody)
    .digest("hex")
    .slice(0, 32);
  const providerEventId = explicitId ?? `${providerEventName}:${bodyHash}`;
  return { providerEventId, providerEventName, occurredAt, result };
}

function metadataCorrelation(result: JsonRecord) {
  return {
    monetplaneOrderId:
      stringValue(result.merchantOrderId) ??
      stringValue(result.merchantSubscriptionId),
    monetplaneCustomerId: userIdFrom(result),
  };
}

function baseNormalizedEvent(
  connection: ProviderConnectionContext,
  event: ReturnType<typeof parseWebhook>,
): Omit<NormalizedProviderEvent, "type" | "rawEventReference"> {
  return {
    provider: "waffo",
    providerConnectionId: connection.id,
    providerEventId: event.providerEventId,
    providerEventName: event.providerEventName,
    applicationId: connection.applicationId,
    occurredAt: event.occurredAt,
  };
}

function unknownEvent(
  connection: ProviderConnectionContext,
  event: ReturnType<typeof parseWebhook>,
): NormalizedProviderEvent {
  return {
    ...baseNormalizedEvent(connection, event),
    type: "unknown",
    rawEventReference: event.providerEventId,
  };
}

function normalizeWaffoWebhook(
  connection: ProviderConnectionContext,
  input: VerifiedWebhook,
): NormalizedProviderEvent {
  const event = parseWebhook(input);
  const result = event.result;
  const base = baseNormalizedEvent(connection, event);
  const correlation = metadataCorrelation(result);

  if (event.providerEventName === "PAYMENT_NOTIFICATION") {
    const payment = normalizePaymentObject(result);
    const subscriptionId = stringValue(
      recordValue(result.subscriptionInfo)?.subscriptionId,
    );
    const type: NormalizedProviderEvent["type"] =
      payment.status === "succeeded"
        ? "payment.succeeded"
        : payment.status === "failed"
          ? "payment.failed"
          : "unknown";
    if (type === "unknown") return unknownEvent(connection, event);
    return {
      ...base,
      ...correlation,
      type,
      providerPaymentId: payment.providerPaymentId,
      providerSubscriptionId: subscriptionId,
      providerCustomerId: payment.providerCustomerId,
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      rawEventReference: event.providerEventId,
    };
  }

  if (event.providerEventName === "REFUND_NOTIFICATION") {
    if (result.refundStatus !== "ORDER_FULLY_REFUNDED") {
      return unknownEvent(connection, event);
    }
    const providerRefundId =
      stringValue(result.acquiringRefundOrderId) ??
      stringValue(result.merchantRefundOrderId) ??
      stringValue(result.refundRequestId);
    const providerPaymentId = stringValue(result.acquiringOrderId);
    if (!providerRefundId || !providerPaymentId) {
      return unknownEvent(connection, event);
    }
    return {
      ...base,
      ...correlation,
      type: "payment.refunded",
      providerRefundId,
      providerPaymentId,
      providerCustomerId: userIdFrom(result),
      amountMinor: centsFromAmount(result.refundAmount),
      rawEventReference: event.providerEventId,
    };
  }

  if (event.providerEventName === "SUBSCRIPTION_STATUS_NOTIFICATION") {
    const subscription = normalizeSubscriptionObject(result);
    const normalizedType: NormalizedProviderEvent["type"] =
      subscription.status === "active"
        ? "subscription.activated"
        : subscription.status === "cancelled"
          ? "subscription.cancelled"
          : subscription.status === "expired"
            ? "subscription.expired"
            : "subscription.updated";
    return {
      ...base,
      ...correlation,
      type: normalizedType,
      providerSubscriptionId: subscription.providerSubscriptionId,
      providerCustomerId: subscription.providerCustomerId,
      subscriptionStatus: subscription.status,
      subscriptionPeriodStart: subscription.currentPeriodStart,
      subscriptionPeriodEnd: subscription.currentPeriodEnd,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      rawEventReference: event.providerEventId,
    };
  }

  if (event.providerEventName === "SUBSCRIPTION_PERIOD_CHANGED_NOTIFICATION") {
    const subscription = normalizeSubscriptionObject(result);
    return {
      ...base,
      ...correlation,
      type: "subscription.renewed",
      providerSubscriptionId: subscription.providerSubscriptionId,
      providerCustomerId: subscription.providerCustomerId,
      subscriptionStatus: subscription.status,
      subscriptionPeriodStart: subscription.currentPeriodStart,
      subscriptionPeriodEnd: subscription.currentPeriodEnd,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      rawEventReference: event.providerEventId,
    };
  }

  if (event.providerEventName === "SUBSCRIPTION_CHANGE_NOTIFICATION") {
    const subscription = normalizeSubscriptionObject(result);
    return {
      ...base,
      ...correlation,
      type: "subscription.updated",
      providerSubscriptionId: subscription.providerSubscriptionId,
      providerCustomerId: subscription.providerCustomerId,
      subscriptionStatus: subscription.status,
      subscriptionPeriodStart: subscription.currentPeriodStart,
      subscriptionPeriodEnd: subscription.currentPeriodEnd,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      rawEventReference: event.providerEventId,
    };
  }

  return unknownEvent(connection, event);
}

export function createWaffoProviderAdapter(
  options: WaffoAdapterOptions = {},
): PaymentProviderAdapter {
  return {
    provider: "waffo",

    getCapabilities() {
      return WAFFO_CAPABILITIES;
    },

    async validateConnection(connection) {
      const client = clientFor(connection, options);
      const merchantId = requiredCredential(connection, "merchantId");
      const response = await sdkCall(
        false,
        () =>
          client.merchantConfig().inquiry?.({ merchantId }) ??
          Promise.reject(
            new Error("Waffo merchant config inquiry is unavailable"),
          ),
      );
      unwrapResponse(response, "merchant configuration inquiry");
      return {
        summary:
          "Waffo merchant configuration inquiry succeeded with RSA request/response verification.",
      };
    },

    async createCheckout(connection, input): Promise<CheckoutResult> {
      if (input.items.length !== 1) {
        throw new ProviderOperationError(
          "Waffo checkout currently supports exactly one item per checkout",
          "rejected",
        );
      }
      const item = input.items[0];
      if (!item) {
        throw new ProviderOperationError(
          "Waffo checkout requires one item",
          "rejected",
        );
      }
      const productName = item.productName?.trim();
      if (!productName) {
        throw new ProviderOperationError(
          "Waffo checkout requires a product name",
          "rejected",
        );
      }
      const customerEmail = input.customerEmail?.trim();
      if (!customerEmail) {
        throw new ProviderOperationError(
          "Waffo checkout requires the application customer to have an email address",
          "rejected",
        );
      }
      const notifyUrl = requiredCredential(connection, "notifyUrl");
      const client = clientFor(connection, options);
      const totalMinor = item.unitAmountMinor * item.quantity;
      const requestedAt = new Date().toISOString();

      if (input.billingMode === "subscription") {
        const response = await sdkCall(
          false,
          () =>
            client.subscription().create?.({
              subscriptionRequest: compactRequestId(
                "sub",
                input.monetplaneOrderId,
              ),
              merchantSubscriptionId: input.monetplaneOrderId,
              currency: input.currency,
              amount: amountString(totalMinor),
              notifyUrl,
              productInfo: {
                description: productName,
                periodType: "MONTHLY",
                periodInterval: input.interval === "year" ? "12" : "1",
              },
              userInfo: {
                userId: input.monetplaneCustomerId,
                userEmail: customerEmail,
              },
              paymentInfo: { productName },
              goodsInfo: {
                goodsId: item.productId,
                goodsName: productName,
                goodsQuantity: item.quantity,
              },
              successRedirectUrl: input.successUrl,
              cancelRedirectUrl: input.cancelUrl,
              requestedAt,
              extendInfo: JSON.stringify({
                monetplaneApplicationId: input.applicationId,
                monetplanePriceId: item.priceId,
              }),
            }) ??
            Promise.reject(
              new Error("Waffo subscription create is unavailable"),
            ),
        );
        const data = unwrapResponse(response, "subscription create");
        const providerCheckoutId =
          stringValue(data.subscriptionId) ??
          stringValue(data.subscriptionRequest) ??
          compactRequestId("sub", input.monetplaneOrderId);
        const checkoutUrl = actionUrl(data.subscriptionAction);
        if (!checkoutUrl) {
          throw new ProviderOperationError(
            "Waffo subscription create response is missing a hosted checkout URL",
            "outcome_uncertain",
          );
        }
        return {
          providerCheckoutId,
          checkoutUrl,
          providerCustomerId: input.monetplaneCustomerId,
          reconciliationMetadata: {
            monetplane_order_id: input.monetplaneOrderId,
            monetplane_customer_id: input.monetplaneCustomerId,
          },
        };
      }

      const response = await sdkCall(
        false,
        () =>
          client.order().create?.({
            paymentRequestId: compactRequestId("pay", input.monetplaneOrderId),
            merchantOrderId: input.monetplaneOrderId,
            orderCurrency: input.currency,
            orderAmount: amountString(totalMinor),
            orderDescription: productName,
            notifyUrl,
            userInfo: {
              userId: input.monetplaneCustomerId,
              userEmail: customerEmail,
            },
            paymentInfo: { productName },
            goodsInfo: {
              goodsId: item.productId,
              goodsName: productName,
              goodsQuantity: item.quantity,
            },
            successRedirectUrl: input.successUrl,
            cancelRedirectUrl: input.cancelUrl,
            orderRequestedAt: requestedAt,
            extendInfo: JSON.stringify({
              monetplaneApplicationId: input.applicationId,
              monetplanePriceId: item.priceId,
            }),
          }) ?? Promise.reject(new Error("Waffo order create is unavailable")),
      );
      const data = unwrapResponse(response, "order create");
      const providerCheckoutId =
        stringValue(data.acquiringOrderId) ??
        stringValue(data.paymentRequestId) ??
        compactRequestId("pay", input.monetplaneOrderId);
      const checkoutUrl = actionUrl(data.orderAction);
      if (!checkoutUrl) {
        throw new ProviderOperationError(
          "Waffo order create response is missing a hosted checkout URL",
          "outcome_uncertain",
        );
      }
      return {
        providerCheckoutId,
        checkoutUrl,
        providerCustomerId: input.monetplaneCustomerId,
        reconciliationMetadata: {
          monetplane_order_id: input.monetplaneOrderId,
          monetplane_customer_id: input.monetplaneCustomerId,
        },
      };
    },

    async getPayment(connection, input): Promise<NormalizedPayment> {
      const client = clientFor(connection, options);
      const response = await sdkCall(
        false,
        () =>
          client
            .order()
            .inquiry?.({ acquiringOrderId: input.providerPaymentId }) ??
          Promise.reject(new Error("Waffo order inquiry is unavailable")),
      );
      return normalizePaymentObject(unwrapResponse(response, "order inquiry"));
    },

    async getSubscription(connection, input): Promise<NormalizedSubscription> {
      const client = clientFor(connection, options);
      const response = await sdkCall(
        false,
        () =>
          client.subscription().inquiry?.({
            subscriptionId: input.providerSubscriptionId,
          }) ??
          Promise.reject(
            new Error("Waffo subscription inquiry is unavailable"),
          ),
      );
      return normalizeSubscriptionObject(
        unwrapResponse(response, "subscription inquiry"),
      );
    },

    async cancelSubscription(
      connection,
      input: CancelSubscriptionInput,
    ): Promise<NormalizedSubscription> {
      const client = clientFor(connection, options);
      const merchantId = requiredCredential(connection, "merchantId");
      const response = await sdkCall(
        true,
        () =>
          client.subscription().cancel?.({
            subscriptionId: input.providerSubscriptionId,
            merchantId,
            requestedAt: new Date().toISOString(),
          }) ??
          Promise.reject(new Error("Waffo subscription cancel is unavailable")),
      );
      unwrapResponse(response, "subscription cancel");
      return {
        providerSubscriptionId: input.providerSubscriptionId,
        status: "cancelled",
        cancelAtPeriodEnd: false,
      };
    },

    async updateSubscription(
      _connection,
      input: UpdateSubscriptionInput,
    ): Promise<NormalizedSubscription> {
      throw new ProviderOperationError(
        `Waffo subscription update is disabled until MonetPlane can provide the full amount/product-period contract for ${input.providerSubscriptionId}`,
        "rejected",
      );
    },

    async refundPayment(
      connection,
      input: RefundPaymentInput,
    ): Promise<NormalizedRefund> {
      if (input.amountMinor === undefined) {
        throw new ProviderOperationError(
          "Waffo refund requires an explicit amount",
          "rejected",
        );
      }
      const client = clientFor(connection, options);
      const merchantId = requiredCredential(connection, "merchantId");
      const refundRequestId = compactRequestId(
        "refund",
        input.requestId ?? `${input.providerPaymentId}:${input.amountMinor}`,
      );
      const response = await sdkCall(
        true,
        () =>
          client.order().refund?.({
            refundRequestId,
            acquiringOrderId: input.providerPaymentId,
            merchantId,
            refundAmount: amountString(input.amountMinor ?? 0),
            refundReason: "MonetPlane operator full refund",
            requestedAt: new Date().toISOString(),
          }) ?? Promise.reject(new Error("Waffo order refund is unavailable")),
      );
      const data = unwrapResponse(response, "order refund");
      const providerRefundId =
        stringValue(data.acquiringRefundOrderId) ??
        stringValue(data.merchantRefundOrderId) ??
        stringValue(data.refundRequestId) ??
        refundRequestId;
      return {
        providerRefundId,
        providerPaymentId: input.providerPaymentId,
        status: mapRefundStatus(data.refundStatus),
        amountMinor: centsFromAmount(data.refundAmount) ?? input.amountMinor,
      };
    },

    async verifyWebhook(
      connection,
      input: VerifyWebhookInput,
    ): Promise<VerifiedWebhook> {
      const signature = headerValue(input.headers, "x-signature");
      if (!signature) {
        throw new InvalidProviderWebhookSignatureError(
          "Missing Waffo webhook signature",
        );
      }
      let valid = false;
      try {
        valid = clientFor(connection, options)
          .webhook()
          .verifySignature(input.rawBody, signature);
      } catch (error) {
        throw new InvalidProviderWebhookSignatureError(
          error instanceof Error
            ? `Waffo webhook verification failed: ${error.message}`
            : "Waffo webhook verification failed",
        );
      }
      if (!valid) {
        throw new InvalidProviderWebhookSignatureError(
          "Invalid Waffo webhook signature",
        );
      }
      return { rawBody: input.rawBody };
    },

    async normalizeWebhook(
      connection,
      input: VerifiedWebhook,
    ): Promise<NormalizedProviderEvent> {
      return normalizeWaffoWebhook(connection, input);
    },
  };
}
