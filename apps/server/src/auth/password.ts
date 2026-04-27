import { type ScryptOptions, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const DEFAULT_N = 16384;
const DEFAULT_R = 8;
const DEFAULT_P = 1;
const DEFAULT_KEY_LEN = 32;
const DEFAULT_SALT_LEN = 16;
const DEFAULT_MAX_MEM_BYTES = 64 * 1024 * 1024;

type ScryptParams = {
  N: number;
  r: number;
  p: number;
  keyLen: number;
};

function scryptAsync(
  password: string | Buffer,
  salt: string | Buffer,
  keyLen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLen, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

function encodeScryptHash(params: ScryptParams, salt: Buffer, key: Buffer): string {
  return [
    "scrypt",
    String(params.N),
    String(params.r),
    String(params.p),
    salt.toString("base64url"),
    key.toString("base64url"),
  ].join("$");
}

function decodeScryptHash(
  hash: string,
): { params: ScryptParams; salt: Buffer; key: Buffer } | null {
  const parts = hash.split("$");
  if (parts.length !== 6) return null;
  if (parts[0] !== "scrypt") return null;

  const N = Number.parseInt(parts[1]!, 10);
  const r = Number.parseInt(parts[2]!, 10);
  const p = Number.parseInt(parts[3]!, 10);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return null;
  if (N <= 1 || r <= 0 || p <= 0) return null;

  const salt = Buffer.from(parts[4]!, "base64url");
  const key = Buffer.from(parts[5]!, "base64url");
  if (salt.length < 8 || key.length < 16) return null;

  return { params: { N, r, p, keyLen: key.length }, salt, key };
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(DEFAULT_SALT_LEN);
  const key = await scryptAsync(password, salt, DEFAULT_KEY_LEN, {
    N: DEFAULT_N,
    r: DEFAULT_R,
    p: DEFAULT_P,
    maxmem: DEFAULT_MAX_MEM_BYTES,
  });
  return encodeScryptHash(
    { N: DEFAULT_N, r: DEFAULT_R, p: DEFAULT_P, keyLen: DEFAULT_KEY_LEN },
    salt,
    key,
  );
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const decoded = decodeScryptHash(hash);
  if (!decoded) return false;

  const actual = await scryptAsync(password, decoded.salt, decoded.params.keyLen, {
    N: decoded.params.N,
    r: decoded.params.r,
    p: decoded.params.p,
    maxmem: DEFAULT_MAX_MEM_BYTES,
  });

  if (actual.length !== decoded.key.length) return false;
  return timingSafeEqual(actual, decoded.key);
}

let dummyHashPromise: Promise<string> | null = null;

export function getDummyPasswordHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(randomBytes(32).toString("hex"));
  return dummyHashPromise;
}
