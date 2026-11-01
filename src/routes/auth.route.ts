import { asyncHandler } from "../middlewares/error.middleware";
import { Router } from "express";
import { LoginSchema, RegisterSchema } from "../validators/auth.validator";
import { AuthController } from "../controllers/auth.controller";
import { validate } from "../middlewares/validate.middleware";
import { authenticate } from "../middlewares/auth.middleware";
import { loginRateLimiter } from "../middlewares/login-rate-limit.middleware";
import { sendSuccess } from "../utils/response";

const router = Router();

router.post("/register", validate(RegisterSchema), asyncHandler(AuthController.register));

router.post("/login", loginRateLimiter, validate(LoginSchema), asyncHandler(AuthController.login));

router.get("/me", authenticate, (req, res) => {
  sendSuccess(res, {
    statusCode: 200, message: "User retrieved", code: "USER_RETRIEVED", data: req.user!,
  });
});
export default router;
