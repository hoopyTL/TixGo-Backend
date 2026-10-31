import { ConflictError, ForbiddenError, UnauthorizedError } from "../errors/http-errors";
import { db } from "../configs/db";
import { RegisterInput, LoginInput } from "../validators/auth.validator";
import { comparePassword, hashPassword } from "../utils/password";
import { signToken } from "../utils/jwt";

export const AuthService = {
  register: async (data: RegisterInput) => {
    const { email, password } = data;
    const user = await db.user.findUnique({ where: { email } });

    if (user) {
      throw new ConflictError("Email đã tồn tại");
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
      throw new UnauthorizedError("Email hoặc mật khẩu không chính xác");
    }

    const isMatch = await comparePassword(password, user.passwordHash);
    if (!isMatch) {
      throw new UnauthorizedError("Email hoặc mật khẩu không chính xác");
    }

    const role = user.role;
    if (role !== "buyer" && role !== "organizer" && role !== "admin") {
      throw new ForbiddenError("Vai trò tài khoản không hợp lệ");
    }

    const accessToken = signToken({ userId: user.id, role });
    return {
      accessToken,
      user: { id: user.id, email: user.email, role: user.role },
    };
  },
};
