import { describe, expect, it } from "vitest";
import {
  hashPassword,
  secretsMatch,
  verifyPassword,
} from "../src/modules/team/password";

describe("operator password hashing (#70)", () => {
  it("round-trips a password through scrypt", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(stored.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("correct horse battery staple", stored)).toBe(
      true,
    );
    expect(await verifyPassword("wrong password", stored)).toBe(false);
  });

  it("salts every hash so identical passwords differ", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).not.toBe(b);
  });

  it("fails closed on malformed or tampered hashes", async () => {
    expect(await verifyPassword("x", "not-a-hash")).toBe(false);
    expect(await verifyPassword("x", "bcrypt$1$2$3$aa$bb")).toBe(false);
    expect(await verifyPassword("x", "scrypt$bad$8$1$zz$zz")).toBe(false);

    const stored = await hashPassword("hunter2");
    const tampered = `${stored.slice(0, -2)}ff`;
    expect(await verifyPassword("hunter2", tampered)).toBe(false);
  });

  it("compares bootstrap secrets in constant time", () => {
    expect(secretsMatch("same", "same")).toBe(true);
    expect(secretsMatch("same", "different")).toBe(false);
    expect(secretsMatch("", "nonempty")).toBe(false);
  });
});
