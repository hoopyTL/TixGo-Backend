import { JwtPayload as JwtLibPayload } from "jsonwebtoken";

/**
 * Payload bên trong JWT token sau khi decode.
 * Kế thừa JwtPayload từ thư viện để có sẵn iat, exp, nbf, etc.
 * Server tạo ra khi login, client gửi lại trong header Authorization.
 */
export interface JwtPayload extends JwtLibPayload {
  userId: string;
  role: "buyer" | "organizer" | "admin";
}

/**
 * Mở rộng Express Request để TypeScript nhận diện req.user
 * Được gắn vào bởi authenticate middleware sau khi verify JWT.
 */
declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}
