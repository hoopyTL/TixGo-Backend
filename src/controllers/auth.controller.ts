import { Request, Response } from "express";
import { AuthService } from "../services/auth.service";
import { sendSuccess } from "../utils/response";

export const AuthController = {
  register: async (req: Request, res: Response) => {
    const user = await AuthService.register(req.body);
    sendSuccess(res, { statusCode: 201, message: "User registered", code: "USER_REGISTERED", data: user });
  },

  login: async (req: Request, res: Response) => {
    const result = await AuthService.login(req.body);
    sendSuccess(res, { statusCode: 200, message: "Login successful", code: "LOGIN_SUCCEEDED", data: result });
  },
};
