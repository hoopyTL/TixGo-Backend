import { Router } from "express";
import { LoginSchema, RegisterSchema } from "../validators/auth.validator";
import { AuthController } from "../controllers/auth.controller";
import { validate } from "../middlewares/validate.middleware";
import { authenticate } from "../middlewares/auth.middleware";

const router = Router();

router.post("/register", validate(RegisterSchema), AuthController.register);

router.post("/login", validate(LoginSchema), AuthController.login);

router.get("/me", authenticate, (req, res) => {
  res.json({
    message: "Lấy thông tin cá nhân thành công",
    user: req.user,
  });
});
export default router;
