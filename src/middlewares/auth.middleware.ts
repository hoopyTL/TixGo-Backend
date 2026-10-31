import { Request, Response, NextFunction } from "express";
import { verifyToken } from "../utils/jwt";
import { UnauthorizedError } from "../errors/http-errors";

export const authenticate = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return next(new UnauthorizedError("Chưa đăng nhập"));
  }

  const token = authHeader.split(" ")[1];

  try {
    const decodedPayload = verifyToken(token);
    if (typeof decodedPayload.userId !== "string" || !decodedPayload.userId.trim()) {
      throw new Error("Token is missing a valid user identity");
    }
    req.user = decodedPayload;
  } catch {
    return next(new UnauthorizedError("Token không hợp lệ hoặc đã hết hạn"));
  }
  next();
};
