import express from "express";
import cors from "cors";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db } from "./db/index.js";
import healthRoutes from "./routes/health.js";
import openapiRoutes from "./routes/openapi.js";
import humanRoutes from "./routes/humans.js";
import methodologyRoutes from "./routes/methodology.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.use(healthRoutes);
app.use(openapiRoutes);
app.use(humanRoutes);
app.use(methodologyRoutes);

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

if (process.env.NODE_ENV !== "test") {
  migrate(db, { migrationsFolder: "./drizzle" })
    .then(() => {
      console.log("Migrations complete");
      app.listen(Number(PORT), "::", () => {
        console.log(`Human service running on port ${PORT}`);
      });
    })
    .catch((err) => {
      console.error("Migration failed:", err);
      process.exit(1);
    });
}

export default app;
