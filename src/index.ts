import express from "express";
import { Request, Response } from "express";
import eventRouter from "./routes/event.route";
import authRouter from "./routes/auth.route";
import "dotenv/config";

const app = express();
const PORT = 3000;
app.use(express.json());
app.use("/events", eventRouter);
app.use("/auth", authRouter);

app.get("/health", (req: Request, res: Response) => {
  res.json({ status: "Ok" });
});

app.listen(PORT, () => {
  console.log(`🚀 Server đang chạy kịch trần tại http://localhost:${PORT}`);
});
