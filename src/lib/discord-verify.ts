import nacl from "tweetnacl";

/**
 * Convert a hexadecimal string to a Uint8Array.
 */
export function hexToUint8Array(hex: string): Uint8Array {
  if (!hex || hex.length % 2 !== 0) {
    return new Uint8Array(0);
  }
  const array = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    const byte = parseInt(hex.substring(i, i + 2), 16);
    if (isNaN(byte)) return new Uint8Array(0);
    array[i / 2] = byte;
  }
  return array;
}

/**
 * Validates incoming Discord webhook signatures using TweetNaCl Ed25519.
 * Validates against X-Signature-Ed25519 and X-Signature-Timestamp headers.
 */
export function verifyDiscordSignature(
  publicKeyHex: string | undefined,
  signatureHex: string | null,
  timestamp: string | null,
  body: string
): boolean {
  if (!publicKeyHex || !signatureHex || !timestamp) {
    return false;
  }

  try {
    const publicKey = hexToUint8Array(publicKeyHex);
    const signature = hexToUint8Array(signatureHex);

    if (publicKey.length !== 32 || signature.length !== 64) {
      return false;
    }

    const message = new TextEncoder().encode(timestamp + body);
    return nacl.sign.detached.verify(message, signature, publicKey);
  } catch (error) {
    console.error("Discord signature verification error:", error);
    return false;
  }
}
