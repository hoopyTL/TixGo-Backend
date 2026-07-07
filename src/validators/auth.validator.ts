import { z } from "zod";

export const RegisterSchema = z
  .object({
    email: z
      .string()
      .min(1, "Email là bắt buộc")
      .email("Email không hợp lệ")
      .toLowerCase(),

    password: z
      .string()
      .min(1, "Mật khẩu là bắt buộc")
      .min(8, "Mật khẩu tối thiểu 8 ký tự"),
  })
  .strict();

export const LoginSchema = z
  .object({
    email: z.string().email("Email không hợp lệ").toLowerCase(),
    password: z.string().min(1, "Vui lòng nhập mật khẩu"),
  })
  .strict();

export type RegisterInput = z.infer<typeof RegisterSchema>;
export type LoginInput = z.infer<typeof LoginSchema>;
