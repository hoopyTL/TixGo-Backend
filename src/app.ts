import "dotenv/config";
import express from "express";
import eventRouter from "./routes/event.route";
import authRouter from "./routes/auth.route";
import bookingRouter from "./routes/booking.route";

export const app = express();
app.disable("x-powered-by");

app.use(express.json());
app.use("/events", eventRouter);
app.use("/auth", authRouter);
app.use("/bookings", bookingRouter);
app.get("/health", (_req, res) => {
  res.json({ status: "Ok" });
});
