import { Router } from "express";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { humanMethodologies } from "../db/schema.js";
import { requireApiKey } from "../middleware/auth.js";
import { TransferBrandRequestSchema } from "../schemas.js";

const router = Router();

// POST /internal/transfer-brand — Transfer solo-brand rows from one org to another
router.post(
  "/internal/transfer-brand",
  requireApiKey,
  async (req, res) => {
    const parsed = TransferBrandRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const { brandId, sourceOrgId, targetOrgId } = parsed.data;

    try {
      // Update human_methodologies where:
      // - org_id matches sourceOrgId
      // - brand_ids has exactly 1 element AND that element is brandId
      const result = await db
        .update(humanMethodologies)
        .set({ orgId: targetOrgId, updatedAt: new Date() })
        .where(
          and(
            eq(humanMethodologies.orgId, sourceOrgId),
            sql`array_length(${humanMethodologies.brandIds}, 1) = 1`,
            sql`${humanMethodologies.brandIds}[1] = ${brandId}`
          )
        )
        .returning({ id: humanMethodologies.id });

      const updatedTables: { tableName: string; count: number }[] = [];
      if (result.length > 0) {
        updatedTables.push({
          tableName: "human_methodologies",
          count: result.length,
        });
      }

      console.log(
        `[human-service] transfer-brand: brandId=${brandId} sourceOrgId=${sourceOrgId} targetOrgId=${targetOrgId} — human_methodologies: ${result.length} rows updated`
      );

      res.json({ updatedTables });
    } catch (err) {
      console.error("[human-service] Error in transfer-brand:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

export default router;
