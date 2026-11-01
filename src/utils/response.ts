import { Response } from "express";

type SuccessOptions<T> = {
  statusCode: 200 | 201;
  message: string;
  code: string;
  data: T;
  meta?: Record<string, unknown>;
};

export function sendSuccess<T>(res: Response, options: SuccessOptions<T>) {
  const { message, code, statusCode, data, meta } = options;
  return res.status(statusCode).json({
    message,
    code,
    statusCode,
    data,
    ...(meta === undefined ? {} : { meta }),
  });
}
