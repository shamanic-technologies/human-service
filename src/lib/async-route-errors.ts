import { createRequire } from "node:module";
import type { NextFunction, Request, Response } from "express";
import { errorMessage } from "./db-error.js";

// Express 4 never awaits a route handler: an async handler that rejects (a
// `throw err` after the known error classes, a failed query) leaves the request
// unanswered, and the caller waits for its own timeout (lead-service: 300 s per
// candidate reveal, DOCDINNERS-REVEAL-HANG-1027). This hands every rejected
// handler promise to `next(err)`, so the error handlers below answer it.
// Same patch as the `express-async-errors` package, on the one method Express 4
// calls per layer. Idempotent.
const require = createRequire(import.meta.url);
const Layer = require("express/lib/router/layer.js") as {
  prototype: { handle_request: (req: Request, res: Response, next: NextFunction) => void; handle: Function; __asyncErrors?: true };
};

if (!Layer.prototype.__asyncErrors) {
  Layer.prototype.__asyncErrors = true;
  Layer.prototype.handle_request = function handleRequest(this: { handle: Function }, req, res, next) {
    const fn = this.handle;
    if (fn.length > 3) return next(); // an error handler: not for a plain request
    try {
      const out = fn(req, res, next);
      if (out && typeof (out as Promise<unknown>).then === "function") {
        (out as Promise<unknown>).then(undefined, (err: unknown) => {
          if (res.headersSent) {
            console.error(`[human-service] route failed after answering: ${errorMessage(err)}`);
            return;
          }
          next(err);
        });
      }
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Last error handler: whatever reached it answers a named JSON 500 (the driver's
 * reason for a failed query, never its SQL or params), never Express's HTML page
 * and never silence.
 */
export function internalErrorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(err);
    return;
  }
  const message = errorMessage(err);
  console.error(`[human-service] request failed ${req.method} ${req.path}: ${message}`);
  res.status(500).json({ error: message, reason: "internal_error" });
}
