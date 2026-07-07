import { db } from "../configs/db";
import { RegisterInput, LoginInput } from "../validators/auth.validator";
import { comparePassword, hashPassword } from "../utils/password";
import { signToken } from "../utils/jwt";
import { AppError } from "../errors/AppError";

export const AuthService = {
  register: async (data: RegisterInput) => {
    const { email, password } = data;
    const user = await db.user.findUnique({ where: { email } });

    if (user) {
      throw new AppError(409, "Email đã tồn tại");
    }

    const passwordHash = await hashPassword(password);
    return db.user.create({
      data: { email, passwordHash },
      select: { id: true, email: true, role: true, createdAt: true },
    });
  },

  login: async (data: LoginInput) => {
    const { email, password } = data;
    const user = await db.user.findUnique({ where: { email } });

    if (!user) {
      throw new AppError(401, "Email hoặc mật khẩu không chính xác");
    }

    const isMatch = await comparePassword(password, user.passwordHash);
    if (!isMatch) {
      throw new AppError(401, "Email hoặc mật khẩu không chính xác");
    }

    const accessToken = signToken({ userId: user.id, role: user.role });
    return {
      accessToken,
      user: { id: user.id, email: user.email, role: user.role },
    };
  },
};
