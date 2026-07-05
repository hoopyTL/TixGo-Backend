import express from "express";
import { Request, Response } from "express";

const app = express();
app.use(express.json());

const PORT = 3000;
app.get("/health", (req: Request, res: Response) => {
  res.json({ status: "Ok" });
});
app.listen(PORT, () => {
  console.log(`🚀 Server đang chạy kịch trần tại http://localhost:${PORT}`);
});
