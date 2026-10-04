// services/relayer/src/assets/http.ts
//
// `GET /assets/:symbol` — public token information (service.ts). Unknown
// symbol → 404. Always 200 with the static text even when the market-data
// upstream is down (`market: null`).
import express from "express";
import type { Router } from "express";
import type { AssetService } from "./service.js";

export function assetsRouter(service: AssetService): Router {
  const router = express.Router();
  router.get("/assets/:symbol", async (req, res) => {
    const info = await service.get(String(req.params.symbol).toUpperCase());
    if (!info) {
      res.status(404).json({ error: `unknown asset: ${req.params.symbol}` });
      return;
    }
    // Numbers move slowly and are cached server-side; a minute client-side is plenty.
    res.setHeader("Cache-Control", "public, max-age=60");
    res.json(info);
  });
  return router;
}
