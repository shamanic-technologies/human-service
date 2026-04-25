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

    const { sourceBrandId, sourceOrgId, targetOrgId, targetBrandId } = parsed.data;

    try {
      // Step 1: Move org — scoped to sourceOrgId + solo-brand
      const step1 = await db
        .update(humanMethodologies)
        .set({ orgId: targetOrgId, updatedAt: new Date() })
        .where(
          and(
            eq(humanMethodologies.orgId, sourceOrgId),
            sql`array_length(${humanMethodologies.brandIds}, 1) = 1`,
            sql`${humanMethodologies.brandIds}[1] = ${sourceBrandId}`
          )
        )
        .returning({ id: humanMethodologies.id });

      // Step 2: Rewrite brand_id globally (no org filter)
      let step2Count = 0;
      if (targetBrandId) {
        const step2 = await db
          .update(humanMethodologies)
          .set({ brandIds: [targetBrandId], updatedAt: new Date() })
          .where(
            and(
              sql`array_length(${humanMethodologies.brandIds}, 1) = 1`,
              sql`${humanMethodologies.brandIds}[1] = ${sourceBrandId}`
            )
          )
          .returning({ id: humanMethodologies.id });
        step2Count = step2.length;
      }

      const totalCount = Math.max(step1.length, step2Count);
      const updatedTables: { tableName: string; count: number }[] = [];
      if (totalCount > 0) {
        updatedTables.push({
          tableName: "human_methodologies",
          count: totalCount,
        });
      }

      console.log(
        `[human-service] transfer-brand: sourceBrandId=${sourceBrandId} targetBrandId=${targetBrandId ?? "none"} sourceOrgId=${sourceOrgId} targetOrgId=${targetOrgId} — step1(org): ${step1.length}, step2(brand): ${step2Count}`
      );

      res.json({ updatedTables });
    } catch (err) {
      console.error("[human-service] Error in transfer-brand:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

export default router;
