import { asyncHandler } from "../middlewares/error.middleware";
import { Router } from "express";
import { EventController } from "../controllers/event.controller";
import { validate } from "../middlewares/validate.middleware";
import { CreateEventSchema } from "../validators/event.validator";
import { authenticate } from "../middlewares/auth.middleware";
import { UpdateEventSchema } from "../validators/resource.validator";

import { ReservationController } from "../controllers/reservation.controller";

const router = Router();
router.get("/:id/seats", asyncHandler(ReservationController.seats));

router.get("/", asyncHandler(EventController.getAllEvents));
router.patch("/:id", authenticate, validate(UpdateEventSchema), asyncHandler(EventController.updateEvent));

router.post("/", authenticate, validate(CreateEventSchema), asyncHandler(EventController.createEvent));

export default router;
