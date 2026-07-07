import { Request, Response } from "express";
import { AuthService } from "../services/auth.service";
import { AppError } from "../errors/AppError";

export const AuthController = {
  register: async (req: Request, res: Response) => {
    try {
      const user = await AuthService.register(req.body);
      res.status(201).json({ data: user });
    } catch (error) {
      if (error instanceof AppError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      console.error("Lỗi Controller register", error);
      return res.status(500).json({ error: "Không thể đăng ký tài khoản" });
    }
  },

  login: async (req: Request, res: Response) => {
    try {
      const result = await AuthService.login(req.body);
      res.status(200).json({ data: result });
    } catch (error) {
      if (error instanceof AppError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      console.error("Lỗi Controller login", error);
      return res.status(500).json({ error: "Không thể đăng nhập" });
    }
  },
};
