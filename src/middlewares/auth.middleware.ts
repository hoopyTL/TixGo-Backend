import { Request, Response, NextFunction } from "express";
import { verifyToken } from "../utils/jwt";

export const authenticate = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({
      error: "Chưa đăng nhập",
    });
    return;
  }

  const token = authHeader.split(" ")[1];

  try {
    const decodedPayload = verifyToken(token);
    req.user = decodedPayload;
    next();
  } catch (error) {
    res.status(401).json({
      error: "Token không hợp lệ hoặc đã hết hạn",
    });
  }
};
