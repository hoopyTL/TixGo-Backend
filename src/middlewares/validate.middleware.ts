import { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { ValidationError } from "../errors/http-errors";

export const validate = (schema: z.ZodSchema) => {
    return (req: Request, res: Response, next: NextFunction): void => {
        const result = schema.safeParse(req.body);

        if (!result.success) {
            return next(new ValidationError("Dữ liệu không hợp lệ"));
        }

        req.body = result.data;
        next();
    };
};
