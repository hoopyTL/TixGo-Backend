import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware";
import { validate } from "../middlewares/validate.middleware";
import { CreateBookingSchema } from "../validators/booking.validator";
import { BookingController } from "../controllers/booking.controller";
import { CancelBookingSchema } from "../validators/resource.validator";

const router = Router();

router.get("/:id", authenticate, BookingController.getBooking);
router.post("/:id/cancel", authenticate, validate(CancelBookingSchema), BookingController.cancelBooking);

router.post(
  "/",
  authenticate,
  validate(CreateBookingSchema),
  BookingController.createBooking,
);

export default router;
