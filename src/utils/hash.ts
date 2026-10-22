import { createHash } from "crypto";

// Tạo mã SHA-256 từ userId và body request để chống payload mismatch
export function generateRequestHash(userId: string, body: any): string {
  const dataString = JSON.stringify({ userId, body });
  return createHash("sha256").update(dataString).digest("hex");
}
