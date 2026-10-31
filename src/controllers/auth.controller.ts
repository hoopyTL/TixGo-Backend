import { Request, Response } from "express";
import { AuthService } from "../services/auth.service";

export const AuthController = {
  register: async (req: Request, res: Response) => {
    const user = await AuthService.register(req.body);
    res.status(201).json({ data: user });
  },

  login: async (req: Request, res: Response) => {
    const result = await AuthService.login(req.body);
    res.status(200).json({ data: result });
  },
};
