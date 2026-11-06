// OUTCOME-PERFORMER-1106: was a list-building run triggered by a PERSON of the client?
//
// A performer is permanent at runs-service (never overwritten), so `client_team` is stated only where the
// client's own user asked for the list: the request reached one of the routes marked `clientPersonRequest`
// (create an audience, confirm a split, launch the portfolio, add a signal / source, switch a source campaign
// on). Everything else (a timer sweep, a staff /internal route, a refill fired from the serve path) is no
// person: its lists state NO performer unless a script asked (the run's workflow slug).
import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request, Response } from "express";

const store = new AsyncLocalStorage<"client_person">();

/** Express middleware: the work of this request (and everything it starts) was asked for by the client's person. */
export function clientPersonRequest(_req: Request, _res: Response, next: NextFunction): void {
  store.run("client_person", next);
}

/** Run `fn` as work a client's person asked for (tests, non-Express entry points). */
export function asClientPersonWork<T>(fn: () => T): T {
  return store.run("client_person", fn);
}

export function triggeredByClientPerson(): boolean {
  return store.getStore() === "client_person";
}
