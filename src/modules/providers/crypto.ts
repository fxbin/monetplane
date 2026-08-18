import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

const CIPHER = "aes-256-gcm";
const VERSION = "v1";
const AAD = Buffer.from("monetplane:provider-credentials:v1", "utf8");

export function decodeProviderEncryptionKey(value: string): Buffer {
  const key = Buffer.from(value.trim(), "base64");
  if (key.length !== 32) {
    throw new Error(
      "MONETPLANE_ENCRYPTION_KEY must be a base64-encoded 32-byte key",
    );
  }
  return key;
}

export function getProviderEncryptionKey(): Buffer {
  const value = process.env.MONETPLANE_ENCRYPTION_KEY?.trim();
  if (!value) {
    throw new Error("MONETPLANE_ENCRYPTION_KEY is required");
  }
  return decodeProviderEncryptionKey(value);
}

export function encryptProviderCredentials(
  credentials: Record<string, string>,
  key: Buffer = getProviderEncryptionKey(),
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(CIPHER, key, iv);
  cipher.setAAD(AAD);

  const plaintext = JSON.stringify(credentials);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
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

export function decryptProviderCredentials(
  encrypted: string,
  key: Buffer = getProviderEncryptionKey(),
): Record<string, string> {
  const [version, ivValue, ciphertextValue, tagValue, ...extra] =
    encrypted.split(":");

  if (
    version !== VERSION ||
    !ivValue ||
    !ciphertextValue ||
    !tagValue ||
    extra.length > 0
  ) {
    throw new Error("Unsupported provider credential ciphertext");
  }

  const decipher = createDecipheriv(
    CIPHER,
    key,
    Buffer.from(ivValue, "base64url"),
  );
  decipher.setAAD(AAD);
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));

  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, "base64url")),
    decipher.final(),
  ]).toString("utf8");

  const parsed: unknown = JSON.parse(plaintext);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid provider credential payload");
  }

  for (const value of Object.values(parsed)) {
    if (typeof value !== "string") {
      throw new Error("Provider credential values must be strings");
    }
  }

  return parsed as Record<string, string>;
}
