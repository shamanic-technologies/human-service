import { Router } from "express";
import { requireApiKey } from "../middleware/auth.js";
import { TransferBrandRequestSchema } from "../schemas.js";
import { transferBrand } from "../services/transfer-brand.js";

const router = Router();

// POST /internal/transfer-brand — move every row of a brand from one org to
// another (fleet contract orchestrated by brand-service). The engine lives in
// src/services/transfer-brand.ts.
router.post("/internal/transfer-brand", requireApiKey, async (req, res) => {
  const parsed = TransferBrandRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    res.json(await transferBrand(parsed.data));
  } catch (err) {
    console.error("[human-service] Error in transfer-brand:", err);
    res.status(500).json({
      error: `transfer-brand failed, nothing was moved: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
});

export default router;
