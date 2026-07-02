import { scrypt, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);
const SALT_BYTES = 16;
const KEY_LEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES).toString("hex");
  const derived = (await scryptAsync(password, salt, KEY_LEN)) as Buffer;
  return `${derived.toString("hex")}.${salt}`;
}

export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  const dotIndex = hash.indexOf(".");
  if (dotIndex === -1) return false;
  const hashHex = hash.slice(0, dotIndex);
  const salt = hash.slice(dotIndex + 1);
  if (!hashHex || !salt) return false;
  const derived = (await scryptAsync(password, salt, KEY_LEN)) as Buffer;
  const stored = Buffer.from(hashHex, "hex");
  if (derived.length !== stored.length) return false;
  return timingSafeEqual(derived, stored);
}
