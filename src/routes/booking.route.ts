import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware";
import { validate } from "../middlewares/validate.middleware";
import { CreateBookingSchema, HoldSchema } from "../validators/booking.validator";
import { BookingController } from "../controllers/booking.controller";
import { CancelBookingSchema } from "../validators/resource.validator";

import { ReservationController } from "../controllers/reservation.controller";

const router = Router();

router.post("/hold", authenticate, validate(HoldSchema), ReservationController.hold);
router.get("/holds/:id", authenticate, ReservationController.get);
router.delete("/holds/:id", authenticate, ReservationController.release);

router.get("/:id", authenticate, BookingController.getBooking);
router.post("/:id/cancel", authenticate, validate(CancelBookingSchema), BookingController.cancelBooking);

router.post(
  "/",
  authenticate,
  validate(CreateBookingSchema),
  BookingController.createBooking,
);

export default router;
