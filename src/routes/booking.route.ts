import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware";
import { validate } from "../middlewares/validate.middleware";
import { CreateBookingSchema } from "../validators/booking.validator";
import { BookingController } from "../controllers/booking.controller";

const router = Router();

router.post(
  "/",
  authenticate,
  validate(CreateBookingSchema),
  BookingController.createBooking,
);

export default router;
