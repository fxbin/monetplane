import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";

const CIPHER = "aes-256-gcm";
const VERSION = "v1";
const AAD = Buffer.from("monetplane:developer-webhook-secret:v1", "utf8");
const SECRET_PREFIX = "mp_whsec_";

function getEncryptionKey(): Buffer {
  const value = process.env.MONETPLANE_ENCRYPTION_KEY?.trim();
  if (!value) {
    throw new Error("MONETPLANE_ENCRYPTION_KEY is required");
  }

  const key = Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw new Error(
      "MONETPLANE_ENCRYPTION_KEY must be a base64-encoded 32-byte key",
    );
  }
  return key;
}

export function encryptWebhookSecret(
  secret: string,
  key: Buffer = getEncryptionKey(),
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(CIPHER, key, iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString("base64url"),
    ciphertext.toString("base64url"),
    tag.toString("base64url"),
  ].join(":");
}

export function decryptWebhookSecret(
  encrypted: string,
  key: Buffer = getEncryptionKey(),
): string {
  const [version, ivValue, ciphertextValue, tagValue, ...extra] =
    encrypted.split(":");
  if (
    version !== VERSION ||
    !ivValue ||
    !ciphertextValue ||
    !tagValue ||
    extra.length > 0
  ) {
    throw new Error("Unsupported webhook secret ciphertext");
  }

  const decipher = createDecipheriv(
    CIPHER,
    key,
    Buffer.from(ivValue, "base64url"),
  );
  decipher.setAAD(AAD);
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function generateWebhookSecret() {
  const token = randomBytes(32).toString("base64url");
  const secret = `${SECRET_PREFIX}${token}`;
  return {
    secret,
    secretPrefix: `${SECRET_PREFIX}${token.slice(0, 8)}`,
    secretCiphertext: encryptWebhookSecret(secret),
  };
}

export function signWebhookPayload(
  secret: string,
  eventId: string,
  timestamp: string,
  rawBody: string,
): string {
  const digest = createHmac("sha256", secret)
    .update(`${timestamp}.${eventId}.${rawBody}`)
    .digest("hex");
  return `v1=${digest}`;
}
