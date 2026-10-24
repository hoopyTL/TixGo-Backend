import { Router } from "express";
import { EventController } from "../controllers/event.controller";
import { validate } from "../middlewares/validate.middleware";
import { CreateEventSchema } from "../validators/event.validator";
import { authenticate } from "../middlewares/auth.middleware";

const router = Router();

router.get("/", EventController.getAllEvents);

router.post("/", authenticate, validate(CreateEventSchema), EventController.createEvent);

export default router;
