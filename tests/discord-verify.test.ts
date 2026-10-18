import { describe, it, expect } from "vitest";
import nacl from "tweetnacl";
import { verifyDiscordSignature, hexToUint8Array } from "../src/lib/discord-verify";

function toHexString(byteArray: Uint8Array): string {
  return Array.from(byteArray, (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

describe("Discord Ed25519 Signature Verification", () => {
  it("should correctly convert hex strings to Uint8Array", () => {
    const hex = "000102feff";
    const bytes = hexToUint8Array(hex);
    expect(bytes).toEqual(new Uint8Array([0, 1, 2, 254, 255]));
  });

  it("should successfully verify a valid Ed25519 signature", () => {
    const keyPair = nacl.sign.keyPair();
    const publicKeyHex = toHexString(keyPair.publicKey);
    const secretKey = keyPair.secretKey;

    const timestamp = "1729000000";
    const body = JSON.stringify({ type: 1 });
    const message = new TextEncoder().encode(timestamp + body);

    const signature = nacl.sign.detached(message, secretKey);
    const signatureHex = toHexString(signature);

    const isValid = verifyDiscordSignature(
      publicKeyHex,
      signatureHex,
      timestamp,
      body
    );
    expect(isValid).toBe(true);
  });

  it("should reject tampered message body", () => {
    const keyPair = nacl.sign.keyPair();
    const publicKeyHex = toHexString(keyPair.publicKey);
    const secretKey = keyPair.secretKey;

    const timestamp = "1729000000";
    const body = JSON.stringify({ type: 1 });
    const message = new TextEncoder().encode(timestamp + body);

    const signature = nacl.sign.detached(message, secretKey);
    const signatureHex = toHexString(signature);

    const isTamperedValid = verifyDiscordSignature(
      publicKeyHex,
      signatureHex,
      timestamp,
      JSON.stringify({ type: 2 }) // altered body
    );
    expect(isTamperedValid).toBe(false);
  });

  it("should return false if parameters are missing", () => {
    expect(verifyDiscordSignature(undefined, "abc", "123", "body")).toBe(false);
    expect(verifyDiscordSignature("pubkey", null, "123", "body")).toBe(false);
    expect(verifyDiscordSignature("pubkey", "sig", null, "body")).toBe(false);
  });
});
